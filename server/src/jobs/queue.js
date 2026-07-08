// A minimal in-process job queue. Good enough for a single-server self-hosted
// deployment. If you outgrow this (multiple server instances, need durability
// across restarts), swap this for BullMQ + Redis — the processProject()
// function in pipeline.js doesn't need to change.

const queue = [];
let running = false;
let runningKey = null;

export function enqueueJob(keyOrJobFn, maybeJobFn) {
  const entry = typeof keyOrJobFn === 'function'
    ? { key: null, jobFn: keyOrJobFn }
    : { key: keyOrJobFn, jobFn: maybeJobFn };

  if (entry.key && (runningKey === entry.key || queue.some((job) => job.key === entry.key))) {
    return false;
  }

  queue.push(entry);
  void runNext();
  return true;
}

async function runNext() {
  if (running) return;
  running = true;
  while (queue.length > 0) {
    const job = queue.shift();
    runningKey = job.key || null;
    try {
      await job.jobFn();
    } catch (err) {
      // Errors are already logged/persisted by the job itself (pipeline.js
      // sets project status to 'failed'). We swallow here so the queue keeps draining.
      console.error('Job failed:', err.message);
    } finally {
      runningKey = null;
    }
  }
  running = false;
}

export function queueLength() {
  return queue.length;
}

export function cancelQueuedJob(key) {
  const index = queue.findIndex((job) => job.key === key);
  if (index === -1) return false;
  queue.splice(index, 1);
  return true;
}

export function isJobQueued(key) {
  return queue.some((job) => job.key === key);
}
