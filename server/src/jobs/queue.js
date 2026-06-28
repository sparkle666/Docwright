// A minimal in-process job queue. Good enough for a single-server self-hosted
// deployment. If you outgrow this (multiple server instances, need durability
// across restarts), swap this for BullMQ + Redis — the processProject()
// function in pipeline.js doesn't need to change.

const queue = [];
let running = false;

export function enqueueJob(jobFn) {
  queue.push(jobFn);
  void runNext();
}

async function runNext() {
  if (running) return;
  running = true;
  while (queue.length > 0) {
    const job = queue.shift();
    try {
      await job();
    } catch (err) {
      // Errors are already logged/persisted by the job itself (pipeline.js
      // sets project status to 'failed'). We swallow here so the queue keeps draining.
      console.error('Job failed:', err.message);
    }
  }
  running = false;
}

export function queueLength() {
  return queue.length;
}
