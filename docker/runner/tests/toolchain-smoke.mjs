#!/usr/bin/env node
// Keep the historical sandbox toolchain in the canonical image, not in a
// provider-specific recipe that a later snapshot cutover can accidentally skip.
import { execFileSync } from "node:child_process";

const commands = [
  "node", "npm", "bun", "python", "python3", "pip3", "gcc", "g++", "make",
  "git", "curl", "zip", "unzip", "7z", "tar", "gzip", "bzip2", "xz", "jq",
  "rg", "tree", "rsync", "wget", "file", "less", "pdftotext", "pandoc",
  "convert", "ffmpeg", "mount-s3", "agent-browser",
];
for (const command of commands) {
  execFileSync("sh", ["-c", 'command -v "$1"', "toolchain-smoke", command], {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 10_000,
  });
}
execFileSync("python3", ["-c", [
  "import venv, pandas, numpy, openpyxl, xlsxwriter, docx, pptx",
  "import pypdf, pdfplumber, PIL, requests, bs4, lxml, markdown",
  "import tabulate, yaml, dateutil, edge_tts",
].join("\n")], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30_000 });
console.log(`PASS sandbox toolchain: ${commands.length} commands and Python document/data modules`);
