/**
 * RingBuffer — fixed-capacity byte buffer used to replay recent PTY output
 * when a client reconnects to an existing session.
 *
 * The buffer stores raw strings (already UTF-8 from node-pty) in a circular
 * array of chunks. When capacity is exceeded the oldest chunks are dropped,
 * keeping roughly `capacityBytes` of the most-recent output.
 */
export class RingBuffer {
        private chunks: string[] = [];
        private totalBytes = 0;
        private readonly capacityBytes: number;

        constructor(capacityBytes = 64 * 1024 /* 64 KB */) {
                this.capacityBytes = capacityBytes;
        }

        push(data: string): void {
                this.chunks.push(data);
                this.totalBytes += Buffer.byteLength(data, "utf8");

                // Evict oldest chunks until we are back within capacity.
                while (this.totalBytes > this.capacityBytes && this.chunks.length > 0) {
                        const evicted = this.chunks.shift()!;
                        this.totalBytes -= Buffer.byteLength(evicted, "utf8");
                }
        }

        /** Return all buffered output as a single string. */
        drain(): string {
                return this.chunks.join("");
        }

        clear(): void {
                this.chunks = [];
                this.totalBytes = 0;
        }

        get byteLength(): number {
                return this.totalBytes;
        }
}
