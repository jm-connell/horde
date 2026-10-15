import { describe, expect, it, vi } from "vitest";
import { ServiceWorkerUpdates, type WaitingWorker } from "./register";

function fakeWorker(state = "installed") {
  const target = new EventTarget();
  const worker = Object.assign(target, {
    state,
    postMessage: vi.fn(),
  }) as WaitingWorker & { postMessage: ReturnType<typeof vi.fn> };
  const setState = (next: string) => {
    worker.state = next;
    target.dispatchEvent(new Event("statechange"));
  };
  return { worker, setState };
}

describe("ServiceWorkerUpdates", () => {
  it("reports a waiting worker and notifies subscribers", () => {
    const updates = new ServiceWorkerUpdates(vi.fn());
    const seen: boolean[] = [];
    updates.subscribe((ready) => seen.push(ready));
    updates.adopt(fakeWorker().worker);
    expect(seen).toEqual([false, true]);
    expect(updates.ready).toBe(true);
  });

  it("clears when the worker activates elsewhere (another tab accepted)", () => {
    const updates = new ServiceWorkerUpdates(vi.fn());
    const { worker, setState } = fakeWorker();
    const seen: boolean[] = [];
    updates.adopt(worker);
    updates.subscribe((ready) => seen.push(ready));
    setState("activated");
    expect(updates.ready).toBe(false);
    expect(seen).toEqual([true, false]);
  });

  it("clears when the worker becomes redundant", () => {
    const updates = new ServiceWorkerUpdates(vi.fn());
    const { worker, setState } = fakeWorker();
    updates.adopt(worker);
    setState("redundant");
    expect(updates.ready).toBe(false);
  });

  it("ignores a stale worker's state change after a newer one was adopted", () => {
    const updates = new ServiceWorkerUpdates(vi.fn());
    const first = fakeWorker();
    const second = fakeWorker();
    updates.adopt(first.worker);
    updates.adopt(second.worker);
    first.setState("redundant");
    expect(updates.ready).toBe(true);
  });

  it("applyUpdate asks a waiting worker to skip waiting without reloading yet", () => {
    const reload = vi.fn();
    const updates = new ServiceWorkerUpdates(reload);
    const { worker } = fakeWorker();
    updates.adopt(worker);
    updates.applyUpdate();
    expect(worker.postMessage).toHaveBeenCalledWith({ type: "SKIP_WAITING" });
    expect(reload).not.toHaveBeenCalled();
  });

  it("applyUpdate reloads directly when the worker is already active", () => {
    const reload = vi.fn();
    const updates = new ServiceWorkerUpdates(reload);
    const { worker } = fakeWorker();
    updates.adopt(worker);
    worker.state = "activated"; // activated without a statechange reaching us
    updates.applyUpdate();
    expect(reload).toHaveBeenCalledTimes(1);
    expect(worker.postMessage).not.toHaveBeenCalled();
  });

  it("does not adopt a worker that is already activated or redundant", () => {
    const updates = new ServiceWorkerUpdates(vi.fn());
    updates.adopt(fakeWorker("activated").worker);
    updates.adopt(fakeWorker("redundant").worker);
    expect(updates.ready).toBe(false);
  });
});
