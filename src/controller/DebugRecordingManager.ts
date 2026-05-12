import { Readable } from 'stream';
import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import { mkdirSync, readdirSync, statSync, unlinkSync, createReadStream, openSync, readSync, closeSync } from 'fs';
import * as path from 'path';
import * as net from 'net';
import { StreamMetadata, AudioCodec } from 'eufy-security-client';
import type { StreamTrigger } from './LocalLivestreamManager.js';
import { ILogObj, Logger } from 'tslog';
import { pickPort } from 'pick-port';

/** Default global cap for all debug recordings on disk (bytes). */
const DEFAULT_MAX_TOTAL_BYTES = 500 * 1024 * 1024; // 500 MB

/** Maximum number of recording files to retain per camera. */
const DEFAULT_MAX_FILES_PER_CAMERA = 5;

/** Maximum chunk size for paginated downloads (2 MB). */
const MAX_DOWNLOAD_CHUNK_BYTES = 2 * 1024 * 1024;

/** FFmpeg input format string for P2P audio codecs. */
function audioFormatForCodec(codec: AudioCodec): string | null {
  switch (codec) {
    case AudioCodec.AAC:
    case AudioCodec.AAC_LC:
    case AudioCodec.AAC_ELD:
      return 'aac';
    default:
      return null;
  }
}

export interface DebugRecordingFile {
  filename: string;
  serial: string;
  timestamp: string;
  type: 'hksv' | 'livestream' | 'processed';
  sizeBytes: number;
  createdAt: number;
}

/** Per-camera recording session state. */
interface RecordingSession {
  ffmpegProcess: ChildProcessWithoutNullStreams;
  videoSocket: net.Socket | null;
  audioSocket: net.Socket | null;
  videoInput: Readable | null;
  audioInput: Readable | null;
}

/**
 * Manages raw P2P stream capture to MP4 files for debugging.
 *
 * When enabled, creates a codec-copy FFmpeg process that muxes the raw
 * H.264 video and AAC audio from the P2P layer directly into an MP4
 * container — no re-encoding, minimal CPU overhead.
 *
 * Supports concurrent recordings from multiple cameras via a per-serial
 * session map.
 *
 * Also provides disk management (rotation, global cap) and listing
 * of available recordings for download.
 */
export class DebugRecordingManager {
  private readonly sessions = new Map<string, RecordingSession>();
  private readonly recordingsDir: string;
  private readonly maxTotalBytes: number;
  private readonly maxFilesPerCamera: number;

  constructor(
    private readonly log: Logger<ILogObj>,
    eufyPath: string,
    maxTotalBytes?: number,
    maxFilesPerCamera?: number,
  ) {
    this.recordingsDir = path.join(eufyPath, 'recordings');
    this.maxTotalBytes = maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
    this.maxFilesPerCamera = maxFilesPerCamera ?? DEFAULT_MAX_FILES_PER_CAMERA;
    mkdirSync(this.recordingsDir, { recursive: true });
  }

  /** Start recording the raw P2P feed to an MP4 file for a specific camera. */
  async startRawRecording(
    serial: string,
    videostream: Readable,
    audiostream: Readable,
    metadata: StreamMetadata,
    sessionId?: string,
    trigger?: StreamTrigger,
  ): Promise<string | null> {
    const sanitizedSerial = serial.replace(/[^A-Za-z0-9_-]/g, '');

    if (this.sessions.has(sanitizedSerial)) {
      this.log.warn(`Raw debug recording already in progress for ${sanitizedSerial} — skipping.`);
      return null;
    }

    const ts = sessionId ?? new Date().toISOString().replace(/[:.]/g, '-');
    const type = trigger ?? 'livestream';
    const filename = `${sanitizedSerial}_${ts}_${type}.mp4`;
    const outputPath = path.join(this.recordingsDir, filename);

    const audioFormat = audioFormatForCodec(metadata.audioCodec);

    try {
      const videoPort = await this.createInputServer(sanitizedSerial, videostream, 'video');
      const audioPort = audioFormat ? await this.createInputServer(sanitizedSerial, audiostream, 'audio') : null;

      const args = this.buildRawMuxArgs(videoPort, audioPort, audioFormat, outputPath, metadata.videoFPS);

      this.log.debug(`Starting raw debug recording: ${filename}`);
      this.log.debug(`FFmpeg raw mux args: ffmpeg ${args.join(' ')}`);

      const ffmpeg = spawn('ffmpeg', args, { env: process.env });

      const session: RecordingSession = {
        ffmpegProcess: ffmpeg,
        videoSocket: null,
        audioSocket: null,
        videoInput: videostream,
        audioInput: audioFormat ? audiostream : null,
      };
      this.sessions.set(sanitizedSerial, session);

      let stderrLines = 0;
      ffmpeg.stderr.on('data', (data: Buffer) => {
        const line = data.toString().trim();
        if (line && stderrLines < 5) {
          stderrLines++;
          this.log.debug(`[Raw Recording ${sanitizedSerial}] ${line}`);
        }
      });

      ffmpeg.on('error', (err) => {
        this.log.error(`Raw recording FFmpeg error (${sanitizedSerial}): ${err.message}`);
        this.cleanupSession(sanitizedSerial);
      });

      ffmpeg.on('exit', (code) => {
        this.log.debug(`Raw recording for ${sanitizedSerial} stopped (exit code: ${code ?? 'signal'}).`);
        this.cleanupSession(sanitizedSerial);
        this.enforceRetentionPolicy(sanitizedSerial);
      });

      return outputPath;
    } catch (err) {
      this.log.error(`Failed to start raw recording for ${sanitizedSerial}: ${err}`);
      this.cleanupSession(sanitizedSerial);
      return null;
    }
  }

  /** Stop the raw recording for a specific camera. */
  stopRawRecording(serial?: string): void {
    const sanitizedSerial = serial?.replace(/[^A-Za-z0-9_-]/g, '');

    if (sanitizedSerial) {
      this.stopSessionBySerial(sanitizedSerial);
    } else {
      // Stop all active sessions
      for (const key of [...this.sessions.keys()]) {
        this.stopSessionBySerial(key);
      }
    }
  }

  /** List all available debug recording files. */
  listRecordings(): DebugRecordingFile[] {
    try {
      const files = readdirSync(this.recordingsDir)
        .filter(f => f.endsWith('.mp4'))
        .map(filename => this.parseRecordingFilename(filename))
        .filter((f): f is DebugRecordingFile => f !== null)
        .sort((a, b) => b.createdAt - a.createdAt);
      return files;
    } catch {
      return [];
    }
  }

  /** Read a recording file in chunks for streaming download. */
  getRecordingStream(filename: string): { stream: ReturnType<typeof createReadStream>; size: number } | null {
    const resolved = this.resolveRecordingPath(filename);
    if (!resolved) return null;

    try {
      const stats = statSync(resolved);
      return { stream: createReadStream(resolved), size: stats.size };
    } catch {
      return null;
    }
  }

  /** Read a chunk of a recording file for paginated download via IPC. */
  readRecordingChunk(filename: string, offset: number, length: number): { data: Buffer; totalSize: number } | null {
    const resolved = this.resolveRecordingPath(filename);
    if (!resolved) return null;

    try {
      const stats = statSync(resolved);
      if (offset >= stats.size) return null;

      const clampedLength = Math.min(length, MAX_DOWNLOAD_CHUNK_BYTES, stats.size - offset);
      const fd = openSync(resolved, 'r');
      const buf = Buffer.alloc(clampedLength);
      readSync(fd, buf, 0, buf.length, offset);
      closeSync(fd);
      return { data: buf, totalSize: stats.size };
    } catch {
      return null;
    }
  }

  /** Delete a specific recording file. */
  deleteRecording(filename: string): boolean {
    const resolved = this.resolveRecordingPath(filename);
    if (!resolved) return false;

    try {
      unlinkSync(resolved);
      return true;
    } catch {
      return false;
    }
  }

  /** Delete all recording files. */
  deleteAllRecordings(): number {
    const files = this.listRecordings();
    let deleted = 0;
    for (const f of files) {
      if (this.deleteRecording(f.filename)) deleted++;
    }
    return deleted;
  }

  /** Get the recordings directory path. */
  getRecordingsDir(): string {
    return this.recordingsDir;
  }

  // --- Private methods ---

  /** Resolve and validate a recording filename to a safe absolute path. */
  private resolveRecordingPath(filename: string): string | null {
    const sanitized = path.basename(filename);
    const filePath = path.join(this.recordingsDir, sanitized);
    const resolved = path.resolve(filePath);

    if (!resolved.startsWith(path.resolve(this.recordingsDir))) {
      this.log.warn(`Path traversal attempt blocked: ${filename}`);
      return null;
    }
    return resolved;
  }

  private stopSessionBySerial(serial: string): void {
    const session = this.sessions.get(serial);
    if (!session) return;

    this.log.debug(`Stopping raw debug recording for ${serial}...`);

    // Close TCP sockets to signal EOF to FFmpeg. This is the only reliable
    // way to stop FFmpeg when it reads from TCP — stdin 'q' is ignored
    // because FFmpeg is blocked in the socket read loop. Socket EOF causes
    // FFmpeg to finalize the MP4 container and exit cleanly.
    if (session.videoSocket && !session.videoSocket.destroyed) {
      session.videoSocket.destroy();
    }
    if (session.audioSocket && !session.audioSocket.destroyed) {
      session.audioSocket.destroy();
    }

    const proc = session.ffmpegProcess;
    const killTimer = setTimeout(() => {
      this.log.warn(`Raw recording FFmpeg for ${serial} did not exit after socket close — killing.`);
      proc.kill('SIGKILL');
    }, 3000);

    proc.on('exit', () => clearTimeout(killTimer));
  }

  private buildRawMuxArgs(
    videoPort: number,
    audioPort: number | null,
    audioFormat: string | null,
    outputPath: string,
    videoFps: number,
  ): string[] {
    // P2P delivers data in bursts, not at a steady real-time rate. Wallclock
    // timestamps reflect burst-arrival times (choppy video, crushed audio).
    // Instead, let FFmpeg generate PTS from the declared framerate for video
    // and from the sample rate for audio — producing smooth playback that
    // matches what HomeKit sees.
    const fps = videoFps > 0 ? videoFps : 15;
    const args: string[] = [
      '-hide_banner',
      '-loglevel', 'error',
      '-fflags', '+genpts',
      '-r', String(fps),
      '-f', 'h264',
      '-i', `tcp://127.0.0.1:${videoPort}`,
    ];

    if (audioPort && audioFormat) {
      args.push(
        '-fflags', '+genpts',
        '-f', audioFormat,
        '-i', `tcp://127.0.0.1:${audioPort}`,
      );
    }

    args.push('-c', 'copy');
    // Raw AAC from P2P is ADTS-wrapped; MP4 container requires raw AAC.
    if (audioPort && audioFormat) {
      args.push('-bsf:a', 'aac_adtstoasc');
    }
    args.push(
      '-f', 'mp4',
      '-movflags', '+faststart',
      outputPath,
    );

    return args;
  }

  private async createInputServer(serial: string, input: Readable, label: string): Promise<number> {
    const port = await pickPort({ type: 'tcp' });

    return new Promise<number>((resolve) => {
      const server = net.createServer((socket) => {
        server.close();

        const session = this.sessions.get(serial);
        if (session) {
          if (label === 'video') {
            session.videoSocket = socket;
          } else {
            session.audioSocket = socket;
          }
        }

        // pipe() automatically drains any data buffered in the PassThrough
        // while FFmpeg was starting up, then continues flowing with backpressure.
        input.pipe(socket);

        input.on('error', () => {
          if (!socket.destroyed) socket.destroy();
        });
        socket.on('error', () => { input.unpipe(socket); });
        socket.on('close', () => {
          input.unpipe(socket);
          if (!input.destroyed) input.destroy();
          const s = this.sessions.get(serial);
          if (s) {
            if (label === 'video') s.videoSocket = null;
            else s.audioSocket = null;
          }
        });
      });

      server.on('error', () => { /* ignore */ });

      const killTimeout = setTimeout(() => {
        server.close();
        this.log.warn(`Raw recording ${label} TCP server for ${serial} timed out — no FFmpeg connection.`);
      }, 10_000);

      server.listen(port, () => {
        resolve(port);
      });

      server.on('connection', () => clearTimeout(killTimeout));
    });
  }

  private cleanupSession(serial: string): void {
    const session = this.sessions.get(serial);
    if (!session) return;

    if (session.videoSocket && !session.videoSocket.destroyed) {
      session.videoSocket.destroy();
    }
    if (session.audioSocket && !session.audioSocket.destroyed) {
      session.audioSocket.destroy();
    }
    // Destroy the PassThrough forks to release backpressure on the source
    // P2P streams. Without this, a crashed FFmpeg leaves the forks alive —
    // they fill their internal buffer and permanently pause the source,
    // starving all other consumers (streaming FFmpeg, file tee).
    if (session.videoInput && !session.videoInput.destroyed) {
      session.videoInput.destroy();
    }
    if (session.audioInput && !session.audioInput.destroyed) {
      session.audioInput.destroy();
    }

    this.sessions.delete(serial);
  }

  /** Remove oldest recordings to stay within per-camera and global limits. */
  private enforceRetentionPolicy(serial: string): void {
    try {
      // Per-camera limit
      const allFiles = this.listRecordings();
      const cameraFiles = allFiles.filter(f => f.serial === serial)
        .sort((a, b) => b.createdAt - a.createdAt);

      if (cameraFiles.length > this.maxFilesPerCamera) {
        const toDelete = cameraFiles.slice(this.maxFilesPerCamera);
        for (const f of toDelete) {
          this.log.debug(`Rotating old recording: ${f.filename}`);
          this.deleteRecording(f.filename);
        }
      }

      // Global size limit
      let totalSize = 0;
      const sortedByAge = this.listRecordings().sort((a, b) => b.createdAt - a.createdAt);
      for (const f of sortedByAge) {
        totalSize += f.sizeBytes;
        if (totalSize > this.maxTotalBytes) {
          this.log.debug(`Global cap exceeded — deleting: ${f.filename}`);
          this.deleteRecording(f.filename);
        }
      }
    } catch (err) {
      this.log.warn(`Retention policy error: ${err}`);
    }
  }

  /** Map legacy type strings to current ones. */
  private normalizeRecordingType(raw?: string): DebugRecordingFile['type'] {
    switch (raw) {
      case 'hksv': return 'hksv';
      case 'livestream': return 'livestream';
      case 'raw': return 'livestream'; // legacy
      case 'processed': return 'processed';
      default: return 'processed'; // legacy files without type suffix
    }
  }

  private parseRecordingFilename(filename: string): DebugRecordingFile | null {
    // Expected format: <serial>_<ISO-timestamp>_<type>.mp4
    // Types: hksv, livestream (current), raw, processed (legacy)
    // or legacy: <serial>_<ISO-timestamp>.mp4 (processed, from existing debug recording)
    // Timestamp in filename: 2024-03-26T14-30-00-000Z (colons and dots replaced with hyphens)
    const match = filename.match(/^([A-Za-z0-9_-]+?)_(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}(?:-\d{3}Z)?)(?:_(hksv|livestream|raw|processed))?\.mp4$/);
    if (!match) return null;

    const filePath = path.join(this.recordingsDir, filename);
    try {
      const stats = statSync(filePath);
      // Restore ISO timestamp: only replace hyphens in the time portion (after the T)
      const rawTs = match[2];
      const tIdx = rawTs.indexOf('T');
      const datePart = rawTs.substring(0, tIdx);
      const timePart = rawTs.substring(tIdx + 1);
      // Time part: 14-30-00-000Z → 14:30:00.000Z
      const restoredTime = timePart
        .replace(/^(\d{2})-(\d{2})-(\d{2})/, '$1:$2:$3')
        .replace(/-(\d{3}Z)$/, '.$1');
      const timestamp = `${datePart} ${restoredTime}`;

      return {
        filename,
        serial: match[1],
        timestamp,
        type: this.normalizeRecordingType(match[3]),
        sizeBytes: stats.size,
        createdAt: stats.mtimeMs,
      };
    } catch {
      return null;
    }
  }
}
