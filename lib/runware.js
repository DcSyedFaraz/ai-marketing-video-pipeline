// Core Runware polling helpers

const POLL_INTERVAL_MS = 3000;
const MAX_WAIT_MS = 10 * 60 * 1000;

export async function submitAndPoll(runware, payload, label, taskUUID) {
  console.log(`\n[${label}] Submitting task ${taskUUID} (async, skipResponse, includeCost)...`);
  const submitStart = Date.now();
  try {
    await runware.videoInference({ ...payload, includeCost: true, skipResponse: true });
  } catch (submitErr) {
    const submitErrMsg = submitErr?.message || (typeof submitErr === 'string' ? submitErr : JSON.stringify(submitErr));
    console.error(`[${label}] Submit failed (full):`, submitErr);
    throw new Error(`Submit failed: ${submitErrMsg}`);
  }
  console.log(`[${label}] Task submitted OK. Polling every ${POLL_INTERVAL_MS / 1000}s...`);

  let attempt = 0;
  const deadline = Date.now() + MAX_WAIT_MS;

  while (Date.now() < deadline) {
    attempt++;
    const elapsed = ((Date.now() - submitStart) / 1000).toFixed(1);
    console.log(`[${label}] Poll #${attempt} | elapsed: ${elapsed}s | taskUUID: ${taskUUID}`);

    try {
      const responses = await runware.getResponse({ taskUUID });
      console.log(`[${label}] Poll #${attempt} | getResponse → ${responses?.length ?? 0} item(s)`);

      if (responses?.length) {
        for (const r of responses) {
          console.log(`[${label}] Poll #${attempt} | raw:`, JSON.stringify(r));
          if (r.error) throw new Error(`API error: ${JSON.stringify(r.error)}`);
          if (r.status === 'success' && r.videoURL) {
            const cost = r.cost ?? r.taskCost ?? r.inferCost ?? null;
            console.log(`[${label}] ✅ SUCCESS after ${elapsed}s | cost: ${cost !== null ? '$' + cost : 'not returned by API'} | URL: ${r.videoURL}`);
            return { ...r, cost };
          }
        }
        console.log(`[${label}] Poll #${attempt} | not ready yet...`);
      } else {
        console.log(`[${label}] Poll #${attempt} | no result yet...`);
      }
    } catch (err) {
      const pollErrMsg = err?.message || (typeof err === 'string' ? err : JSON.stringify(err));
      console.error(`[${label}] Poll #${attempt} | ERROR (full):`, err);
      throw err instanceof Error ? err : new Error(pollErrMsg);
    }

    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error(`Timed out after ${MAX_WAIT_MS / 1000}s waiting for video.`);
}

export async function checkOnce(runware, taskUUID, label) {
  console.log(`[${label}] Manual check for taskUUID: ${taskUUID}`);
  const responses = await runware.getResponse({ taskUUID });
  console.log(`[${label}] Manual check → ${responses?.length ?? 0} item(s)`);
  if (responses?.length) {
    for (const r of responses) {
      console.log(`[${label}] item:`, JSON.stringify({ status: r.status, videoURL: r.videoURL || null, error: r.error || null }));
      if (r.error) throw new Error(`API error: ${JSON.stringify(r.error)}`);
      if (r.status === 'success' && r.videoURL) return r;
    }
  }
  return null;
}
