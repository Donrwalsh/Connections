import { Queue } from "bullmq";
import { MistralRpdResumeBootstrap } from "./mistral-rpd-resume.bootstrap";

describe("MistralRpdResumeBootstrap", () => {
  const realNodeEnv = process.env.NODE_ENV;
  let queue: { add: jest.Mock };

  beforeEach(() => {
    queue = { add: jest.fn().mockResolvedValue(undefined) };
  });

  afterEach(() => {
    process.env.NODE_ENV = realNodeEnv;
  });

  it("enqueues one date-stamped startup catch-up sweep and nothing else", async () => {
    process.env.NODE_ENV = "development";
    const bootstrap = new MistralRpdResumeBootstrap(queue as unknown as Queue);

    await bootstrap.onApplicationBootstrap();

    expect(queue.add).toHaveBeenCalledTimes(1);
    const [name, data, opts] = queue.add.mock.calls[0];
    expect(name).toBe("resume-mistral-rpd");
    expect(data).toEqual({});
    expect((opts as { jobId: string }).jobId).toBe(
      `mistral-rpd-resume-startup-catch-up-${new Date().toISOString().slice(0, 10)}`,
    );
  });

  it("skips scheduling under NODE_ENV=test", async () => {
    process.env.NODE_ENV = "test";
    const bootstrap = new MistralRpdResumeBootstrap(queue as unknown as Queue);

    await bootstrap.onApplicationBootstrap();

    expect(queue.add).not.toHaveBeenCalled();
  });
});
