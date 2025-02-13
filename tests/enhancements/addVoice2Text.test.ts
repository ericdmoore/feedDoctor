import { skip } from "../helpers.ts";
import {
  asserts,
  readableStreamFromReader,
  StringReader,
} from "../../src/deps.ts";
import {
  readToString,
  streamToString,
} from "../../src/lib/utils/pumpReader.ts";
import {
  cacheOurBreadcrumbs,
  haveEverStarted,
  isMediaFinished,
  makeKey,
  // splitBucketItemURL,
  splitSynthTaskResponse,
  textToVoice,
} from "../../src/lib/enhancements/addVoice2text/addVoice2text.ts";

import {
  type SynthesisTaskConfig,
  type SynthesisTaskIdentifiers,
} from "../../src/lib/clients/aws-polly.ts";

import {
  type ASTcomputable,
  ASTFeedItemJson,
  type ASTjson,
  ASTKindJson,
  computableToJson,
  rezVal,
} from "../../src/lib/parsers/ast.ts";
import { urlToAST } from "../../src/lib/start.ts";
import { s3Mock } from "../mocks/s3/s3Mock.ts";
import {
  jsonFeed,
  jsonFeedUrl,
} from "../mocks/jsonFeed/daringFireball.elon.ts";
import mkEnvVar from "../../src/lib/utils/vars.ts";

// mod.ts audit: OK
import { S3Bucket } from "https://denopkg.com/ericdmoore/s3_deno@main/mod.ts";

type AST = ASTjson | ASTcomputable;
type ASTItem = typeof ASTFeedItemJson.TYPE;
type ASTItemAssertion = (item: ASTItem) => Promise<void>;
type ASTAllAssertion = (item: AST) => Promise<void>;

console.warn("WARNING: This Test Runs Against Production Resources");

const _encoder = new TextEncoder();
const _s3stateGlobal = new Map<string, Uint8Array>();

const envs = mkEnvVar("MISSING-KEY-VALUE");
const cfg = async () => ({
  aws: {
    key: await envs("AWS_KEY"),
    secret: await envs("AWS_SECRET"),
    region: await envs("REGION"),
  },
  config: {
    s3: {
      bucket: await envs("POLLYBUCKET"),
      prefix: await envs("POLLYPREFIX"),
    },
  },
});

const runAssertions =
  (...ASTassertionFns: ASTAllAssertion[]) =>
  (...itemAssertionFns: ASTItemAssertion[]) =>
  async (ast: AST) => {
    // console.log('ast: ', ast)
    const _ast = await computableToJson(ast);

    ASTassertionFns.forEach(async (fASTAssert) => await fASTAssert(ast));

    itemAssertionFns.forEach((fItemAssert) => {
      _ast.items.forEach(async (item, _i) => {
        // console.log({ i, 'Len(attachedList)': item.attachments.length, item })
        await fItemAssert(item);
      });
    });
  };

const allAttachmentsShouldHave = (p: string) =>
  `All attachments should have a ${p}`;
const assertPropertyPresensce =
  (prop: string, msg: (prop: string) => string) =>
  (obj: { [key: string]: unknown }) => asserts.assert(obj[prop], msg(prop));
const dynamicPresenceAssertion = (prop: string) =>
  assertPropertyPresensce(prop, allAttachmentsShouldHave);

const propertyAssertions = {
  url: dynamicPresenceAssertion,
  title: dynamicPresenceAssertion,
  mimeType: dynamicPresenceAssertion,
  sizeInBytes: dynamicPresenceAssertion,
  durationInSeconds: dynamicPresenceAssertion,
};

const buildDynamicAssertions = (
  assertionMap: {
    [prop: string]: (
      prop: string,
    ) => (obj: { [key: string]: unknown }) => void;
  },
) =>
(obj: { [key: string]: unknown }) => {
  Object.entries(assertionMap).forEach(([prop, assertionFn]) => {
    assertionFn(prop)(obj);
  });
};

const testItemsHaveValidAttachments = async (item: ASTItem) => {
  const attachentList = await rezVal(item.attachments);
  const dynamicAssertions = buildDynamicAssertions(propertyAssertions);
  asserts.assertEquals(
    attachentList.length > 0,
    true,
    "All ast items should have attachment",
  );

  for (const attach of attachentList) {
    dynamicAssertions(attach);
    // assert(attach.url, 'All attachments should have a url');
    // assert(attach.title, 'All attachments should have a title');
    // assert(attach.mimeType, 'All attachments should have mimeType');
    // assert(attach.sizeInBytes, 'All attachments should have sizeInBytes');
    // assert(attach.durationInSeconds, 'All attachments should have durationInSeconds')
  }
};

Deno.test("streamToString", async () => {
  const data = { a: 1, b: 2, c: "c", d: { e: 5, f: null } };
  const dataStr = JSON.stringify(data);
  const strR = new StringReader(dataStr);
  const rs0 = readableStreamFromReader(strR);

  const s0 = await streamToString(rs0);
  const o0 = JSON.parse(s0);
  asserts.assertEquals(o0, data);
});

Deno.test("readToString", async () => {
  const input = "Hello";
  const rsInput = readableStreamFromReader(new StringReader(input));
  const collected = await readToString(rsInput);
  asserts.assertEquals(input, collected);
});

Deno.test({
  name: "Valid Attachment For Each Entry ",
  // only: true,
  fn: async () => {
    const addTextFn = textToVoice(await cfg());
    const ast = await computableToJson(
      urlToAST({ url: jsonFeedUrl, txt: jsonFeed }),
    );
    const astWithAttachment = await computableToJson(addTextFn(ast));
    runAssertions() /* All AST assertions */(testItemsHaveValidAttachments)(
      astWithAttachment,
    );
  },
});

Deno.test({
  name: "Homomorphic Enhancement",
  fn: async () => {
    const ast = urlToAST({ url: jsonFeedUrl, txt: jsonFeed });
    const addTextFn = textToVoice(await cfg());
    const astWithAttachment = await computableToJson(addTextFn(ast));
    // console.log(JSON.stringify(astWithAttachment, null, 2))
    const [err, data] = ASTKindJson.validate(astWithAttachment);
    asserts.assertEquals(err, undefined);
    asserts.assert(
      data,
      "The AST should now be validated - and thus not undefined",
    );
  },
});

Deno.test("Enhancement Validates S3 Params", () => {
  const ast = urlToAST({ url: jsonFeedUrl, txt: jsonFeed });
  const addTextFn = textToVoice({
    aws: {
      key: "sillyExample",
      region: "us-west-2",
      secret: "somethingNotTooEmbarrasing",
    },
    config: { s3: { bucket: 5, prefix: "" } },
    // deno-lint-ignore no-explicit-any
  } as any);
  asserts.assertRejects(() => addTextFn(ast));
});

Deno.test("Validates S3 Params", () => {
  const ast = urlToAST({ url: jsonFeedUrl, txt: jsonFeed });
  const addTextFn = textToVoice({
    aws: {
      key: "sillyExample",
      region: "us-west-2",
      secret: "somethingNotTooEmbarrasing",
    },
    config: {
      s3: { bucket: 42, prefix: "" },
    },
    // deno-lint-ignore no-explicit-any
  } as any);
  asserts.assertRejects(() => addTextFn(ast));
});

Deno.test("Validates Dynamo Params", () => {
  const ast = urlToAST({ url: jsonFeedUrl, txt: jsonFeed });
  const addTextFn = textToVoice({
    aws: {
      key: "sillyExample",
      region: "us-west-2",
      secret: "somethingNotTooEmbarrasing",
    },
    config: {
      s3: { bucket: "42", prefix: "prefix" },
      dynamo: { table: undefined },
    },
    // deno-lint-ignore no-explicit-any
  } as any);
  asserts.assertRejects(() => addTextFn(ast));
});

Deno.test("makeKey changes for config + corpus", async () => {
  const ka1 = await makeKey({ a: 1 }, "itemText");
  const ka2 = await makeKey({ a: 2 }, "itemText");
  const kb1 = await makeKey({ a: 1 }, "item Text");

  asserts.assertNotEquals(ka1, ka2);
  asserts.assertNotEquals(ka1, kb1);
  asserts.assertNotEquals(kb1, ka2);
});

Deno.test("S3 Mock Unit Test", async () => {
  const s3m = s3Mock();
  const data = { a: 1, b: 2, c: { d: 4, e: 5 } };
  await s3m.putObject("someKey", data);
  const s3DataStr = await streamToString((await s3m.getObject("someKey")).body);
  const s3DataObj = JSON.parse(s3DataStr);

  // console.log('>> await readToString(fromS3Mock) :: ', s3DataStr)
  // console.log('>> parsed data object :: ', s3DataObj)

  asserts.assertEquals(s3DataObj, data);
});

Deno.test("haveEverStarted is based on breadcrumbs", async () => {
  const s3m = s3Mock() as unknown as S3Bucket;
  const key = "abcd";
  const url = `https://example.com/${key}`;
  const item = {
    title: "example",
    url,
    id: url,
    authors: [{ name: "Eric", imageUri: "http://example.com" }],
    content: { text: "Some Text" },
    images: { bannerImage: "", indexImage: "" },
    links: {
      category: "",
      nextPost: "",
      prevPost: "",
      externalURLs: [],
      tags: [],
      relLinks: {},
    },
    attachments: [],
    dates: { modified: Date.now(), published: Date.now() },
  };

  const pollyconfig = {
    OutputFormat: "mp3",
    Engine: "neural",
    LanguageCode: "en-US",
    LexiconNames: ["english"],
    SampleRate: "24000",
    VoiceId: "Matthew",
    SpeechMarkTypes: ["sentence"],
    TextType: "text",
  } as SynthesisTaskConfig;

  const IDs = {
    CreationTime: (new Date().getTime()),
    TaskStatus: "inProgress",
    SnsTopicArn: "",
    TaskId: "some-uuid-that-has-hypens-and-numbers",
    OutputUri: "mock://data",
    TaskStatusReason: "",
    RequestCharacters: 42,
  } as SynthesisTaskIdentifiers;

  await cacheOurBreadcrumbs(
    item,
    key,
    pollyconfig,
    IDs,
    s3m,
  );
  const hasStarted = await haveEverStarted(key, s3m);
  // console.log({hasStarted})
  asserts.assertEquals(hasStarted && true, true);
});

Deno.test("isMediaFinished is based on bread crumbs", async () => {
  const s3m = s3Mock() as unknown as S3Bucket;

  const itemNum = 1234;
  const url = `https://example.com/${itemNum}`;
  const item = {
    title: "example",
    url,
    id: url,
    authors: [{ name: "Eric", imageUri: "http://example.com" }],
    content: {
      text:
        "Some Text that will end up in an S3 bucket... but their will also be a meta data object that exists in another s3 location",
    },
    images: { bannerImage: "", indexImage: "" },
    links: {
      category: "",
      nextPost: "",
      prevPost: "",
      externalURLs: [],
      tags: [],
      relLinks: {},
    },
    attachments: [],
    dates: { modified: Date.now(), published: Date.now() },
  };
  const status: "completed" | "failed" | "inProgress" | "scheduled" =
    "inProgress";

  const synthTask = {
    SynthesisTask: {
      TaskStatus: status,
      TaskId: "a1b2c3d4",
      CreationTime: Date.now(),
      OutputFormat: "mp3" as const,
      OutputUri: "https://audio.example.com/1234",
      Engine: "neural" as const,
      LanguageCode: "en-US" as const,
      LexiconNames: [""],
      RequestCharacters: 42,
      SampleRate: "24000",
      SnsTopicArn: "",
      SpeechMarkTypes: ["sentence"] as ["sentence"],
      TaskStatusReason: "",
      TextType: "text" as const,
      VoiceId: "Matthew" as const,
    },
  };

  const key = await makeKey(item, item.content.text);
  const { taskIDs, ...tcfg } = splitSynthTaskResponse(synthTask.SynthesisTask);
  const breadCrumbs = await cacheOurBreadcrumbs(
    item,
    key,
    tcfg.config,
    taskIDs,
    s3m,
  );
  const hasStarted = await haveEverStarted(key, s3m);

  asserts.assertEquals("sk" in breadCrumbs, true);
  asserts.assertEquals("pk" in breadCrumbs, true);
  asserts.assertEquals("item" in breadCrumbs, true);
  asserts.assertEquals("task" in breadCrumbs, true);

  if (hasStarted) {
    const isFinished = await isMediaFinished(hasStarted);
    asserts.assertEquals(isFinished, false);
  }
  asserts.assertEquals(!!hasStarted, true);
});

Deno.test("isMediaFinished is now complete", async () => {
  const s3m = s3Mock() as unknown as S3Bucket;

  const itemNum = 1234;
  const url = `https://example.com/${itemNum}`;
  const item = {
    title: "example",
    url,
    id: url,
    authors: [{ name: "Eric", imageUri: "http://example.com" }],
    content: {
      text:
        "Some Text that will end up in an S3 bucket... but their will also be a meta data object that exists in another s3 location",
    },
    images: { bannerImage: "", indexImage: "" },
    links: {
      category: "",
      nextPost: "",
      prevPost: "",
      externalURLs: [],
      tags: [],
      relLinks: {},
    },
    attachments: [],
    dates: { modified: Date.now(), published: Date.now() },
  };
  const status: "completed" | "failed" | "inProgress" | "scheduled" =
    "completed";

  const synthTask = {
    SynthesisTask: {
      TaskStatus: status,
      TaskStatusReason: "",
      TaskId: "a1b2c3d4",
      CreationTime: Date.now(),
      OutputFormat: "mp3" as const,
      OutputUri: "https://audio.example.com/1234",
      Engine: "neural" as const,
      LanguageCode: "en-US" as const,
      LexiconNames: [""],
      RequestCharacters: 42,
      SampleRate: "24000",
      SnsTopicArn: "",
      SpeechMarkTypes: ["sentence"] as ["sentence"],
      TextType: "text" as const,
      VoiceId: "Matthew" as const,
    },
  };

  const key = await makeKey(item, item.content.text);

  const { taskIDs, ...tcfg } = splitSynthTaskResponse(synthTask.SynthesisTask);
  const breadCrumbs = await cacheOurBreadcrumbs(
    item,
    key,
    tcfg.config,
    taskIDs,
    s3m,
  );
  const hasStarted = await haveEverStarted(key, s3m);

  asserts.assertEquals("sk" in breadCrumbs, true);
  asserts.assertEquals("pk" in breadCrumbs, true);
  asserts.assertEquals(breadCrumbs.pk, breadCrumbs.sk);
  asserts.assertEquals("item" in breadCrumbs, true);
  asserts.assertEquals("task" in breadCrumbs, true);
  asserts.assertEquals(!!hasStarted, true);

  if (hasStarted) {
    const isFinished = await isMediaFinished(hasStarted);
    asserts.assertEquals(isFinished, true);
  }
});

Deno.test(skip("example", async () => {}));

// WAIT FOR the s3 resources to show ... then delete
