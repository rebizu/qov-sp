// QOV Player - Playback and statistics display

import { QovDecoder } from './qov-decoder';
import {
  QovFrame,
  QovFileStats,
  QOV_FLAG_HAS_ALPHA,
  QOV_FLAG_HAS_MOTION,
  QOV_FLAG_HAS_INDEX,
  QOV_FLAG_HAS_BFRAMES,
  QOV_FLAG_ENHANCED_COMP,
  QOV_CHUNK_KEYFRAME,
  QOV_CHUNK_PFRAME,
  QOV_CHUNK_SYNC,
  QOV_CHUNK_AUDIO,
} from './qov-types';

// DOM Elements
const playerCanvas = document.getElementById('playerCanvas') as HTMLCanvasElement;
const dropZone = document.getElementById('dropZone') as HTMLDivElement;
const fileInput = document.getElementById('fileInput') as HTMLInputElement;
const playBtn = document.getElementById('playBtn') as HTMLButtonElement;
const prevFrameBtn = document.getElementById('prevFrameBtn') as HTMLButtonElement;
const nextFrameBtn = document.getElementById('nextFrameBtn') as HTMLButtonElement;
const prevKeyframeBtn = document.getElementById('prevKeyframeBtn') as HTMLButtonElement;
const nextKeyframeBtn = document.getElementById('nextKeyframeBtn') as HTMLButtonElement;
const timeDisplay = document.getElementById('timeDisplay') as HTMLSpanElement;
const speedSelect = document.getElementById('speedSelect') as HTMLSelectElement;
const timelineProgress = document.getElementById('timelineProgress') as HTMLDivElement;
const timelineKeyframes = document.getElementById('timelineKeyframes') as HTMLDivElement;
const timelineCursor = document.getElementById('timelineCursor') as HTMLDivElement;
const timelineClickable = document.getElementById('timelineClickable') as HTMLDivElement;
const chunkList = document.getElementById('chunkList') as HTMLDivElement;

// Info elements
const infoMagic = document.getElementById('infoMagic') as HTMLDivElement;
const infoVersion = document.getElementById('infoVersion') as HTMLDivElement;
const infoResolution = document.getElementById('infoResolution') as HTMLDivElement;
const infoFrameRate = document.getElementById('infoFrameRate') as HTMLDivElement;
const infoTotalFrames = document.getElementById('infoTotalFrames') as HTMLDivElement;
const infoDuration = document.getElementById('infoDuration') as HTMLDivElement;
const infoFileSize = document.getElementById('infoFileSize') as HTMLDivElement;
const infoColorspace = document.getElementById('infoColorspace') as HTMLDivElement;
const infoFlags = document.getElementById('infoFlags') as HTMLDivElement;
const infoCurrentFrame = document.getElementById('infoCurrentFrame') as HTMLDivElement;
const infoFrameType = document.getElementById('infoFrameType') as HTMLDivElement;
const infoTimestamp = document.getElementById('infoTimestamp') as HTMLDivElement;
const infoDecodeFps = document.getElementById('infoDecodeFps') as HTMLDivElement;

// State
let decoder: QovDecoder | null = null;
let frames: QovFrame[] = [];
let fileStats: QovFileStats | null = null;
let currentFrameIndex = 0;
let isPlaying = false;
let playbackSpeed = 1;
let animationFrameId: number | null = null;
let lastPlaybackTime = 0;
let decodeStartTime = 0;
let framesDecoded = 0;

const ctx = playerCanvas.getContext('2d')!;

// Format time as MM:SS
function formatTime(microseconds: number): string {
  const seconds = microseconds / 1000000;
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

// Format file size
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

// Get colorspace name
function getColorspaceName(cs: number): string {
  const names: Record<number, string> = {
    0x00: 'sRGB',
    0x01: 'sRGBA',
    0x02: 'Linear RGB',
    0x03: 'Linear RGBA',
    0x10: 'YUV 4:2:0',
    0x11: 'YUV 4:2:2',
    0x12: 'YUV 4:4:4',
    0x13: 'YUVA 4:2:0',
  };
  return names[cs] || `Unknown (0x${cs.toString(16)})`;
}

// Get flags description
function getFlagsDescription(flags: number): string {
  const parts: string[] = [];
  if (flags & QOV_FLAG_HAS_ALPHA) parts.push('Alpha');
  if (flags & QOV_FLAG_HAS_MOTION) parts.push('Motion');
  if (flags & QOV_FLAG_HAS_INDEX) parts.push('Index');
  if (flags & QOV_FLAG_HAS_BFRAMES) parts.push('B-frames');
  if (flags & QOV_FLAG_ENHANCED_COMP) parts.push('Enhanced');
  return parts.length > 0 ? parts.join(', ') : 'None';
}

// Update header info display
function updateHeaderInfo(): void {
  if (!fileStats) return;

  const header = fileStats.header;
  infoMagic.textContent = header.magic;
  infoVersion.textContent = `0x${header.version.toString(16).padStart(2, '0')}`;
  infoResolution.textContent = `${header.width} x ${header.height}`;
  infoFrameRate.textContent = `${header.frameRateNum / header.frameRateDen} fps`;
  infoTotalFrames.textContent = header.totalFrames.toString();
  infoDuration.textContent = formatTime(fileStats.duration);
  infoFileSize.textContent = formatSize(fileStats.fileSize);
  infoColorspace.textContent = getColorspaceName(header.colorspace);
  infoFlags.textContent = getFlagsDescription(header.flags);
}

// Update playback info display
function updatePlaybackInfo(): void {
  if (frames.length === 0) return;

  const frame = frames[currentFrameIndex];
  infoCurrentFrame.textContent = `${currentFrameIndex + 1} / ${frames.length}`;
  infoFrameType.textContent = frame.isKeyframe ? 'Keyframe (I)' : 'P-Frame';
  infoTimestamp.textContent = `${(frame.timestamp / 1000).toFixed(1)} ms`;

  const elapsed = (performance.now() - decodeStartTime) / 1000;
  if (elapsed > 0 && framesDecoded > 0) {
    infoDecodeFps.textContent = (framesDecoded / elapsed).toFixed(1);
  }
}

// Render keyframe markers on timeline
function renderTimelineKeyframes(): void {
  timelineKeyframes.innerHTML = '';

  if (!fileStats || frames.length === 0) return;

  for (const kfIndex of fileStats.keyframeIndices) {
    const percent = (kfIndex / frames.length) * 100;
    const marker = document.createElement('div');
    marker.className = 'keyframe-marker';
    marker.style.left = `${percent}%`;
    timelineKeyframes.appendChild(marker);
  }
}

// Render chunk list
function renderChunkList(): void {
  chunkList.innerHTML = '';

  if (!fileStats) return;

  // Show first 100 chunks to avoid performance issues
  const chunksToShow = fileStats.chunks.slice(0, 100);

  for (const chunk of chunksToShow) {
    const item = document.createElement('div');
    item.className = 'chunk-item';

    if (chunk.type === QOV_CHUNK_KEYFRAME) item.classList.add('keyframe');
    else if (chunk.type === QOV_CHUNK_PFRAME) item.classList.add('pframe');
    else if (chunk.type === QOV_CHUNK_SYNC) item.classList.add('sync');
    else if (chunk.type === QOV_CHUNK_AUDIO) item.classList.add('audio');

    item.innerHTML = `
      <span class="chunk-type">${chunk.typeName}</span>
      <span class="chunk-offset">@${chunk.offset}</span>
      <span class="chunk-size">${formatSize(chunk.size)}</span>
    `;
    chunkList.appendChild(item);
  }

  if (fileStats.chunks.length > 100) {
    const more = document.createElement('div');
    more.style.cssText = 'color: #64748b; font-size: 0.8rem; padding: 0.5rem; text-align: center;';
    more.textContent = `... and ${fileStats.chunks.length - 100} more chunks`;
    chunkList.appendChild(more);
  }
}

// Display a frame on canvas
function displayFrame(index: number): void {
  if (index < 0 || index >= frames.length) return;

  currentFrameIndex = index;
  const frame = frames[index];

  // Create ImageData and put on canvas
  const imageData = ctx.createImageData(
    fileStats!.header.width,
    fileStats!.header.height
  );
  imageData.data.set(frame.pixels);
  ctx.putImageData(imageData, 0, 0);

  // Update UI
  updatePlaybackInfo();
  updateTimelinePosition();
  updateTimeDisplay();
}

// Update timeline position
function updateTimelinePosition(): void {
  if (frames.length === 0) return;

  const percent = (currentFrameIndex / (frames.length - 1)) * 100;
  timelineProgress.style.width = `${percent}%`;
  timelineCursor.style.left = `${percent}%`;
}

// Update time display
function updateTimeDisplay(): void {
  if (frames.length === 0 || !fileStats) return;

  const currentTime = frames[currentFrameIndex].timestamp;
  timeDisplay.textContent = `${formatTime(currentTime)} / ${formatTime(fileStats.duration)}`;
}

// Enable controls
function enableControls(): void {
  playBtn.disabled = false;
  prevFrameBtn.disabled = false;
  nextFrameBtn.disabled = false;
  prevKeyframeBtn.disabled = false;
  nextKeyframeBtn.disabled = false;
}

// Load QOV file
async function loadFile(file: File): Promise<void> {
  console.log(`Loading QOV file: ${file.name}, size: ${file.size} bytes`);

  try {
    const buffer = await file.arrayBuffer();
    const data = new Uint8Array(buffer);
    console.log(`File loaded into buffer`);

    decoder = new QovDecoder(data);
    fileStats = decoder.getFileStats();
    console.log(`File stats:`, fileStats.header);
    console.log(`Chunks found: ${fileStats.chunks.length}`);
    console.log(`Keyframes: ${fileStats.keyframeIndices.length}`);

    // Set canvas size
    playerCanvas.width = fileStats.header.width;
    playerCanvas.height = fileStats.header.height;
    console.log(`Canvas size: ${playerCanvas.width}x${playerCanvas.height}`);

    // Decode all frames
    frames = [];
    decodeStartTime = performance.now();
    framesDecoded = 0;

    console.log(`Starting frame decode...`);
    for (const frame of decoder.decodeFrames()) {
      frames.push(frame);
      framesDecoded++;
      if (framesDecoded % 100 === 0) {
        console.log(`Decoded ${framesDecoded} frames...`);
      }
    }
    console.log(`Decoding complete: ${frames.length} frames`);

    // Update UI
    updateHeaderInfo();
    renderTimelineKeyframes();
    renderChunkList();
    enableControls();
    dropZone.classList.add('hidden');

    // Display first frame
    if (frames.length > 0) {
      displayFrame(0);
      console.log(`Displayed first frame`);
    } else {
      console.error(`No frames decoded!`);
      alert(`No frames could be decoded from this file. Check console for details.`);
    }
  } catch (err) {
    console.error(`Error loading QOV file:`, err);
    alert(`Error loading QOV file: ${err}`);
  }
}

// Playback loop
function playbackLoop(): void {
  if (!isPlaying || frames.length === 0) return;

  const now = performance.now();
  const elapsed = now - lastPlaybackTime;
  const frameInterval = (1000 / (fileStats!.header.frameRateNum / fileStats!.header.frameRateDen)) / playbackSpeed;

  if (elapsed >= frameInterval) {
    lastPlaybackTime = now;

    if (currentFrameIndex < frames.length - 1) {
      displayFrame(currentFrameIndex + 1);
    } else {
      // End of video
      stopPlayback();
      return;
    }
  }

  animationFrameId = requestAnimationFrame(playbackLoop);
}

// Start playback
function startPlayback(): void {
  if (frames.length === 0) return;

  isPlaying = true;
  playBtn.innerHTML = '&#10074;&#10074; Pause';
  lastPlaybackTime = performance.now();
  playbackLoop();
}

// Stop playback
function stopPlayback(): void {
  isPlaying = false;
  playBtn.innerHTML = '&#9654; Play';
  if (animationFrameId) {
    cancelAnimationFrame(animationFrameId);
    animationFrameId = null;
  }
}

// Find nearest keyframe before given index
function findPrevKeyframe(fromIndex: number): number {
  if (!fileStats) return 0;

  for (let i = fileStats.keyframeIndices.length - 1; i >= 0; i--) {
    if (fileStats.keyframeIndices[i] < fromIndex) {
      return fileStats.keyframeIndices[i];
    }
  }
  return 0;
}

// Find nearest keyframe after given index
function findNextKeyframe(fromIndex: number): number {
  if (!fileStats) return frames.length - 1;

  for (const kfIndex of fileStats.keyframeIndices) {
    if (kfIndex > fromIndex) {
      return kfIndex;
    }
  }
  return frames.length - 1;
}

// Event listeners

// Drag and drop
dropZone.addEventListener('click', () => fileInput.click());

dropZone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropZone.classList.add('dragover');
});

dropZone.addEventListener('dragleave', () => {
  dropZone.classList.remove('dragover');
});

dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropZone.classList.remove('dragover');

  const files = e.dataTransfer?.files;
  if (files && files.length > 0) {
    loadFile(files[0]);
  }
});

fileInput.addEventListener('change', () => {
  const files = fileInput.files;
  if (files && files.length > 0) {
    loadFile(files[0]);
  }
});

// Play/pause
playBtn.addEventListener('click', () => {
  if (isPlaying) {
    stopPlayback();
  } else {
    // If at end, restart from beginning
    if (currentFrameIndex >= frames.length - 1) {
      displayFrame(0);
    }
    startPlayback();
  }
});

// Frame navigation
prevFrameBtn.addEventListener('click', () => {
  stopPlayback();
  if (currentFrameIndex > 0) {
    displayFrame(currentFrameIndex - 1);
  }
});

nextFrameBtn.addEventListener('click', () => {
  stopPlayback();
  if (currentFrameIndex < frames.length - 1) {
    displayFrame(currentFrameIndex + 1);
  }
});

prevKeyframeBtn.addEventListener('click', () => {
  stopPlayback();
  const kfIndex = findPrevKeyframe(currentFrameIndex);
  displayFrame(kfIndex);
});

nextKeyframeBtn.addEventListener('click', () => {
  stopPlayback();
  const kfIndex = findNextKeyframe(currentFrameIndex);
  displayFrame(kfIndex);
});

// Speed control
speedSelect.addEventListener('change', () => {
  playbackSpeed = parseFloat(speedSelect.value);
});

// Timeline click
timelineClickable.addEventListener('click', (e) => {
  if (frames.length === 0) return;

  const rect = timelineClickable.getBoundingClientRect();
  const percent = (e.clientX - rect.left) / rect.width;
  const frameIndex = Math.floor(percent * frames.length);

  stopPlayback();
  displayFrame(Math.max(0, Math.min(frameIndex, frames.length - 1)));
});

// Keyboard shortcuts
document.addEventListener('keydown', (e) => {
  if (frames.length === 0) return;

  switch (e.key) {
    case ' ':
      e.preventDefault();
      if (isPlaying) stopPlayback();
      else startPlayback();
      break;
    case 'ArrowLeft':
      e.preventDefault();
      stopPlayback();
      if (e.shiftKey) {
        displayFrame(findPrevKeyframe(currentFrameIndex));
      } else {
        if (currentFrameIndex > 0) displayFrame(currentFrameIndex - 1);
      }
      break;
    case 'ArrowRight':
      e.preventDefault();
      stopPlayback();
      if (e.shiftKey) {
        displayFrame(findNextKeyframe(currentFrameIndex));
      } else {
        if (currentFrameIndex < frames.length - 1) displayFrame(currentFrameIndex + 1);
      }
      break;
    case 'Home':
      e.preventDefault();
      stopPlayback();
      displayFrame(0);
      break;
    case 'End':
      e.preventDefault();
      stopPlayback();
      displayFrame(frames.length - 1);
      break;
  }
});
