'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const {createHash} = require('node:crypto');
const {fileURLToPath} = require('node:url');

const videoExtension = /\.(mp4|mov|mkv|webm|avi|m4v|mpg|mpeg|wmv)$/i;
const extensions = "mp4|mov|mkv|webm|avi|m4v|mpg|mpeg|wmv|png|jpe?g|webp|gif|tiff?|exr|bmp|svg|blend|max|fbx|obj|abc|usd[acz]?|glb|gltf|stl|uproject|uasset|drp|drt|aep|prproj|psd|pdf|md|txt|docx?|xlsx?|pptx?|csv|tsv|json|html?|zip|7z|rar|wav|mp3|flac|aac|m4a|srt|vtt|py|ps1|js|ts|cjs|mjs|ms|mat|cube|hdr";
const artifactExtension = new RegExp("\\.(?:"+extensions+")$", "i");
const maxLine = 512 * 1024;

function localArtifact(value, root) {
  let target = value.trim();
  try {
    if (/^file:\/\//i.test(target)) target = fileURLToPath(target);
    else {
      if (/^\/[a-z]:\//i.test(target)) target = target.slice(1);
      if (/%[0-9a-f]{2}/i.test(target)) target = decodeURIComponent(target);
    }
  } catch { return null; }
  if (!target || /[<>:"|?*\x00-\x1f]/.test(target.replace(/^[a-z]:/i, ''))) return null;
  if (/^[a-z]:[\\/]/i.test(target)) {
    target = path.win32.normalize(target);
  } else {
    if (/^[\\/]/.test(target)) return null;
    const relative = path.relative(root, path.resolve(root, target));
    if (relative === '..' || relative.startsWith('..'+path.sep) || path.isAbsolute(relative)) return null;
    target = path.resolve(root, relative);
  }
  return artifactExtension.test(target) ? target : null;
}

function collectArtifacts(line, root, artifacts) {
  let record;
  try { record = JSON.parse(line.toString('utf8')); } catch { return; }
  const message = record.payload;
  if (record.type !== 'response_item' || message?.type !== 'message' || message.role !== 'assistant' ||
      !['commentary', 'final', 'final_answer'].includes(message.phase) || !Number.isFinite(Date.parse(record.timestamp))) return;
  if (!Array.isArray(message.content)) return;
  for (const part of message.content) {
    if (part.type !== 'output_text' || typeof part.text !== 'string') continue;
    const links = part.text.matchAll(/\[([^\]\r\n]*)\]\(\s*(?:<([^>\r\n]+)>|([^\r\n]*?\.(?:mp4|mov|mkv|webm|avi|m4v|mpg|mpeg|wmv|png|jpe?g|webp|gif|tiff?|exr|bmp|svg|blend|max|fbx|obj|abc|usd[acz]?|glb|gltf|stl|uproject|uasset|drp|drt|aep|prproj|psd|pdf|md|txt|docx?|xlsx?|pptx?|csv|tsv|json|html?|zip|7z|rar|wav|mp3|flac|aac|m4a|srt|vtt|py|ps1|js|ts|cjs|mjs|ms|mat|cube|hdr)))\s*\)|\x60([^\x60\r\n]+)\x60|^\s*((?:\/?[a-z]:[\\/]|file:\/\/)[^\r\n]+)\s*$/gim);
    for (const [, label, angled, linked, quoted, plain] of links) {
      const target = localArtifact(angled || linked || quoted || plain, root);
      if (!target) continue;
      const id = createHash('sha256').update(process.platform === 'win32' ? target.toLowerCase() : target).digest('hex');
      if (!artifacts.has(id)) artifacts.set(id, {id, target, label: label?.trim().slice(0, 160) || path.basename(target), at: record.timestamp, kind: videoExtension.test(target) ? "video" : "file"});
    }
  }
}

async function scanArtifacts(file, root, previous) {
  const handle = await fs.open(file, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error('聊天记录不是普通文件');
    const same = previous?.file === file && previous.ino === stat.ino && previous.size <= stat.size;
    const artifacts = new Map(same ? previous.artifacts : []);
    let offset = same ? previous.offset : 0;
    let carry = Buffer.alloc(0), oversized = false;
    const buffer = Buffer.alloc(256 * 1024);
    for (let position = offset; position < stat.size;) {
      const {bytesRead} = await handle.read(buffer, 0, Math.min(buffer.length, stat.size-position), position);
      if (!bytesRead) break;
      let start = 0;
      for (let end; (end = buffer.subarray(0, bytesRead).indexOf(10, start)) !== -1; start = end+1) {
        if (!oversized && carry.length+end-start <= maxLine) {
          collectArtifacts(Buffer.concat([carry, buffer.subarray(start, end)]), root, artifacts);
        }
        carry = Buffer.alloc(0);
        oversized = false;
        offset = position+end+1;
      }
      const remaining = buffer.subarray(start, bytesRead);
      oversized ||= carry.length+remaining.length > maxLine;
      if (!oversized) carry = Buffer.concat([carry, remaining]);
      position += bytesRead;
    }
    return {file, ino: stat.ino, size: stat.size, offset, artifacts};
  } finally { await handle.close(); }
}

async function resolveArtifact(target) {
  const actual = await fs.realpath(target).catch(() => null);
  if (!actual || !artifactExtension.test(actual) ||
      (process.platform === 'win32' && !/^[a-z]:\\/i.test(actual)) ||
      !(await fs.stat(actual).catch(() => null))?.isFile()) {
    throw new Error('产出原文件已移动、不可访问或不在本机磁盘');
  }
  return {path: actual, play: videoExtension.test(target) && videoExtension.test(actual)};
}

async function listAvailableArtifacts(index) {
  const candidates = [...index.artifacts.values()].sort((a,b) => Date.parse(b.at)-Date.parse(a.at));
  const available = [];
  for (let start = 0; start < candidates.length; start += 32) {
    const batch = await Promise.all(candidates.slice(start, start+32).map(async ({id,label,at,target}) => {
      const file = await resolveArtifact(target).catch(() => null);
      return file && {id,label,at,kind:file.play ? 'video' : 'file'};
    }));
    available.push(...batch.filter(Boolean));
  }
  return available;
}

module.exports = {scanArtifacts, resolveArtifact, listAvailableArtifacts};
