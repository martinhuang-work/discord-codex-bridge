import { dirname } from 'node:path';
import { privateDirectory, readPrivateFile, writePrivateFile } from './private-files.js';

const dictionary = value => value && typeof value === 'object' && !Array.isArray(value)
  && !Object.keys(value).some(key => ['__proto__', 'constructor', 'prototype'].includes(key));

export function finishJob(job) {
  job.status = 'done';
  for (const key of ['text', 'attachments', 'answer', 'mentionHelp', 'retryAt']) delete job[key];
}

// One bot process owns this file. Atomic replacement preserves it across restarts.
export class Store {
  constructor(path) {
    this.path = path;
    privateDirectory(dirname(path));
    try { this.data = JSON.parse(readPrivateFile(path, 8 * 1024 * 1024)); }
    catch (error) {
      if (error.code !== 'ENOENT') throw new Error('Cannot read bridge state; preserve the file and inspect it before restarting.');
      this.data = { version: 1, policyVersion: 2, sessions: {}, contexts: {}, jobs: {} };
    }
    if (this.data.version !== 1 || !dictionary(this.data.sessions) || !dictionary(this.data.jobs)
      || (this.data.contexts !== undefined && !dictionary(this.data.contexts))) {
      throw new Error('Unsupported bridge state format.');
    }
    this.data.contexts ??= {};
    if (Object.values(this.data.sessions).some(value => typeof value !== 'string')
      || Object.values(this.data.contexts).some(value => typeof value !== 'string')
      || (this.data.policyVersion !== undefined && ![1, 2].includes(this.data.policyVersion))) {
      throw new Error('Unsupported bridge state format.');
    }
    for (const [id, job] of Object.entries(this.data.jobs)) {
      if (!job || job.id !== id || !['queued', 'running', 'answer', 'done'].includes(job.status)
        || !['key', 'channelId', 'guildId', 'userId'].every(key => typeof job[key] === 'string')
        || job.key !== `${job.guildId}_${job.channelId}`
        || !Number.isFinite(job.createdAt)
        || (job.status === 'queued' && (typeof job.text !== 'string' || !Array.isArray(job.attachments)))
        || (job.status === 'answer' && typeof job.answer !== 'string')) {
        throw new Error('Invalid saved job. Preserve the state file and inspect it locally.');
      }
    }
    if (this.data.policyVersion !== 2) {
      // Old conversations may contain outputs from tools this release disables.
      // Keep selected context files, but do not replay work under the old policy.
      this.data.sessions = {};
      for (const job of Object.values(this.data.jobs)) finishJob(job);
      this.data.policyVersion = 2;
    }
  }
  save() {
    // Retain recent completed IDs to ignore duplicate Discord deliveries.
    const finished = Object.values(this.data.jobs).filter(j => j.status === 'done');
    for (const job of finished.slice(0, Math.max(0, finished.length - 500))) delete this.data.jobs[job.id];
    writePrivateFile(this.path, JSON.stringify(this.data));
  }
}
