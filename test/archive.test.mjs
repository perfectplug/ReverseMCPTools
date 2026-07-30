import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { c as createTar } from "tar";

import { extractArchive } from "../dist/core/download.js";

const ZIP_FIXTURE =
  "UEsDBBQAAAAIABy0/lw90VK+GQAAABcAAAAJAAAAaGVsbG8udHh0y03MS0xPTVFILErOyCxLVUjLrCgpLUoFAFBLAQIUABQAAAAIABy0/lw90VK+GQAAABcAAAAJAAAAAAAAAAAAAAAAAAAAAABoZWxsby50eHRQSwUGAAAAAAEAAQA3AAAAQAAAAAAA";
const TRAVERSAL_ZIP =
  "UEsDBBQAAAAIACS0/lyOsOglCAAAAAYAAAANAAAALi4vZXNjYXBlLnR4dEstTk4sSAUAUEsBAhQAFAAAAAgAJLT+XI6w6CUIAAAABgAAAA0AAAAAAAAAAAAAAAAAAAAAAC4uL2VzY2FwZS50eHRQSwUGAAAAAAEAAQA7AAAAMwAAAAAA";

test("extractArchive handles bundled ZIP and tar.gz implementations", async () => {
  const scratch = await fsp.mkdtemp(path.join(os.tmpdir(), "remcp-archive-"));
  try {
    const zip = path.join(scratch, "fixture.zip");
    const zipDest = path.join(scratch, "zip output");
    await fsp.writeFile(zip, Buffer.from(ZIP_FIXTURE, "base64"));
    await extractArchive(zip, zipDest);
    assert.equal(
      await fsp.readFile(path.join(zipDest, "hello.txt"), "utf8"),
      "managed archive fixture",
    );

    const source = path.join(scratch, "tar source");
    const tarball = path.join(scratch, "fixture.tar.gz");
    const tarDest = path.join(scratch, "tar output");
    await fsp.mkdir(source);
    await fsp.writeFile(path.join(source, "hello.txt"), "managed tar fixture");
    await createTar(
      { cwd: source, file: tarball, gzip: true },
      ["hello.txt"],
    );
    await extractArchive(tarball, tarDest);
    assert.equal(
      await fsp.readFile(path.join(tarDest, "hello.txt"), "utf8"),
      "managed tar fixture",
    );
  } finally {
    await fsp.rm(scratch, { recursive: true, force: true });
  }
});

test("extractArchive rejects ZIP path traversal", async () => {
  const scratch = await fsp.mkdtemp(path.join(os.tmpdir(), "remcp-zipslip-"));
  try {
    const zip = path.join(scratch, "traversal.zip");
    const destination = path.join(scratch, "output");
    const escaped = path.join(scratch, "escape.txt");
    await fsp.writeFile(zip, Buffer.from(TRAVERSAL_ZIP, "base64"));
    await assert.rejects(
      extractArchive(zip, destination),
      /unsafe archive entry|invalid relative path|out of bounds/i,
    );
    await assert.rejects(fsp.access(escaped));
  } finally {
    await fsp.rm(scratch, { recursive: true, force: true });
  }
});
