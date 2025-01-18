// QOV Player - Streaming playback and statistics display

import {
  QovStreamingDecoder,
  FileDataSource,
  UrlDataSource,
} from './qov-streaming-decoder';
import {
  QovFrame,
  QovFileStats,
  QovHeader,
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
const urlInput = document.getElementById('urlInput') as HTMLInputElement;
const loadUrlBtn = document.getElementById('loadUrlBtn') as HTMLButtonElement;
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
const timelineLoaded = document.getElementById('timelineLoaded') as HTMLDivElement;
const chunkList = document.getElementById('chunkList') as HTMLDivElement;
const loadingIndicator = document.getElementById('loadingIndicator') as HTMLDivElement;
const loadingText = document.getElementById('loadingText') as HTMLSpanElement;

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
let decoder: QovStreamingDecoder | null = null;
let fileStats: QovFileStats | null = null;
let currentFrameIndex = 0;
let isPlaying = false;
let playbackSpeed = 1;
let animationFrameId: number | null = null;
let lastPlaybackTime = 0;
let decodeStartTime = 0;
let framesDecoded = 0;
let totalFrames = 0;

// Frame cache for smooth playback
const frameCache = new Map<number, QovFrame>();
const MAX_CACHE_SIZE = 60; // Cache up to 60 frames

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
function updateHeaderInfo(header: QovHeader): void {
  infoMagic.textContent = header.magic;
  infoVersion.textContent = `0x${header.version.toString(16).padStart(2, '0')}`;
  infoResolution.textContent = `${header.width} x ${header.height}`;
  infoFrameRate.textContent = `${header.frameRateNum / header.frameRateDen} fps`;
  infoTotalFrames.textContent = header.totalFrames > 0 ? header.totalFrames.toString() : 'Streaming...';
  infoDuration.textContent = fileStats ? formatTime(fileStats.duration) : '-';
  infoFileSize.textContent = fileStats ? formatSize(fileStats.fileSize) : '-';
  infoColorspace.textContent = getColorspaceName(header.colorspace);
  infoFlags.textContent = getFlagsDescription(header.flags);
}

// Update playback info display
function updatePlaybackInfo(frame: QovFrame | null): void {
  if (!frame) return;

  infoCurrentFrame.textContent = `${currentFrameIndex + 1} / ${totalFrames}`;
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

  if (!decoder || totalFrames === 0) return;

  const keyframeIndices = decoder.getKeyframeIndices();
  for (const kfIndex of keyframeIndices) {
    const percent = (kfIndex / totalFrames) * 100;
    const marker = document.createElement('div');
    marker.className = 'keyframe-marker';
    marker.style.left = `${percent}%`;
    timelineKeyframes.appendChild(marker);
  }
}

// Render chunk list
function renderChunkList(): void {
  chunkList.innerHTML = '';

  if (!fileStats) {
    chunkList.innerHTML = '<div style="color: #64748b; font-size: 0.85rem;">Loading chunks...</div>';
    return;
  }

  // Show first 100 chunks to avoid performance issues
  const chunksToShow = fileStats.chunks.slice(0, 100);

  for (const chunk of chunksToShow) {
    const item = document.createElement('div');
    item.className = 'chunk-item';

    if (chunk.type === QOV_CHUNK_KEYFRAME) item.classList.add('keyframe');
    else if (chunk.type === QOV_CHUNK_PFRAME) item.classList.add('pframe');
    else if (chunk.type === QOV_CHUNK_SYNC) item.classList.add('sync');
    else if (chunk.type === QOV_CHUNK_AUDIO) item.classList.add('audio');

    const compressedBadge = chunk.isCompressed ? ' <span style="color:#22c55e;font-size:0.7rem">[LZ4]</span>' : '';
    item.innerHTML = `
      <span class="chunk-type">${chunk.typeName}${compressedBadge}</span>
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
async function displayFrame(index: number): Promise<void> {
  if (!decoder || index < 0 || index >= totalFrames) return;

  currentFrameIndex = index;

  // Check cache first
  let frame: QovFrame | undefined = frameCache.get(index);

  if (!frame) {
    // Decode frame
    const decoded = await decoder.decodeFrame(index);
    if (!decoded) return;
    frame = decoded;

    // Add to cache
    frameCache.set(index, frame);
    framesDecoded++;

    // Evict old frames if cache is too large
    if (frameCache.size > MAX_CACHE_SIZE) {
      // Remove frames far from current position
      const keysToDelete: number[] = [];
      for (const key of frameCache.keys()) {
        if (Math.abs(key - index) > MAX_CACHE_SIZE / 2) {
          keysToDelete.push(key);
        }
      }
      for (const key of keysToDelete) {
        frameCache.delete(key);
      }
    }
  }

  // Create ImageData and put on canvas
  const header = decoder.getHeader()!;
  const imageData = ctx.createImageData(header.width, header.height);
  imageData.data.set(frame.pixels);
  ctx.putImageData(imageData, 0, 0);

  // Update UI
  updatePlaybackInfo(frame);
  updateTimelinePosition();
  updateTimeDisplay();

  // Pre-fetch next frames
  prefetchFrames(index);
}

// Pre-fetch frames ahead for smooth playback
async function prefetchFrames(currentIndex: number): Promise<void> {
  if (!decoder) return;

  const prefetchCount = 5;
  for (let i = 1; i <= prefetchCount; i++) {
    const idx = currentIndex + i;
    if (idx >= totalFrames || frameCache.has(idx)) continue;

    // Decode and cache in background
    decoder.decodeFrame(idx).then(frame => {
      if (frame) {
        frameCache.set(idx, frame);
      }
    });
  }
}

// Update timeline position
function updateTimelinePosition(): void {
  if (totalFrames === 0) return;

  const percent = (currentFrameIndex / Math.max(1, totalFrames - 1)) * 100;
  timelineProgress.style.width = `${percent}%`;
  timelineCursor.style.left = `${percent}%`;
}

// Update time display
function updateTimeDisplay(): void {
  const frame = frameCache.get(currentFrameIndex);
  const currentTime = frame?.timestamp || 0;
  const duration = fileStats?.duration || 0;
  timeDisplay.textContent = `${formatTime(currentTime)} / ${formatTime(duration)}`;
}

// Update loading progress
function updateLoadingProgress(loadedBytes: number, totalBytes: number | null): void {
  if (totalBytes && timelineLoaded) {
    const percent = (loadedBytes / totalBytes) * 100;
    timelineLoaded.style.width = `${percent}%`;
  }

  if (loadingText) {
    if (totalBytes) {
      loadingText.textContent = `Loading: ${formatSize(loadedBytes)} / ${formatSize(totalBytes)}`;
    } else {
      loadingText.textContent = `Loading: ${formatSize(loadedBytes)}`;
    }
  }
}

// Enable controls
function enableControls(): void {
  playBtn.disabled = false;
  prevFrameBtn.disabled = false;
  nextFrameBtn.disabled = false;
  prevKeyframeBtn.disabled = false;
  nextKeyframeBtn.disabled = false;
}

// Show loading indicator
function showLoading(message: string): void {
  if (loadingIndicator) {
    loadingIndicator.style.display = 'flex';
    loadingText.textContent = message;
  }
}

// Hide loading indicator
function hideLoading(): void {
  if (loadingIndicator) {
    loadingIndicator.style.display = 'none';
  }
}

// Load QOV file from File object
async function loadFile(file: File): Promise<void> {
  console.log(`Loading QOV file: ${file.name}, size: ${file.size} bytes`);
  showLoading('Loading file...');

  try {
    const buffer = await file.arrayBuffer();
    const data = new Uint8Array(buffer);
    console.log(`File loaded into buffer`);

    const source = new FileDataSource(data);
    await loadFromSource(source);
  } catch (err) {
    console.error(`Error loading QOV file:`, err);
    alert(`Error loading QOV file: ${err}`);
    hideLoading();
  }
}

// Load QOV file from URL
async function loadUrl(url: string): Promise<void> {
  console.log(`Loading QOV from URL: ${url}`);
  showLoading('Connecting...');

  try {
    const source = new UrlDataSource(url);
    await source.init();
    await loadFromSource(source);
  } catch (err) {
    console.error(`Error loading QOV from URL:`, err);
    alert(`Error loading QOV from URL: ${err}`);
    hideLoading();
  }
}

// Load from any data source
async function loadFromSource(source: FileDataSource | UrlDataSource): Promise<void> {
  // Reset state
  frameCache.clear();
  currentFrameIndex = 0;
  framesDecoded = 0;
  decodeStartTime = performance.now();
  totalFrames = 0;

  // Create decoder
  decoder = new QovStreamingDecoder(source);

  // Setup callbacks
  decoder.onProgress = (loaded, total) => {
    updateLoadingProgress(loaded, total);
  };

  decoder.onHeaderReady = (header) => {
    console.log(`Header ready:`, header);

    // Set canvas size
    playerCanvas.width = header.width;
    playerCanvas.height = header.height;

    updateHeaderInfo(header);
    dropZone.classList.add('hidden');
  };

  decoder.onFrameReady = (frameIndex, estimatedTotal) => {
    totalFrames = frameIndex;
    if (loadingText) {
      loadingText.textContent = `Indexing: ${frameIndex} frames`;
    }
    if (estimatedTotal > 0) {
      infoTotalFrames.textContent = `${frameIndex} / ${estimatedTotal}`;
    }
  };

  // Parse header
  showLoading('Parsing header...');
  await decoder.parseHeader();

  // Build index (scans all chunks)
  showLoading('Building index...');
  await decoder.buildIndex();

  totalFrames = decoder.getFrameCount();
  console.log(`Index built: ${totalFrames} frames`);

  // Get file stats
  fileStats = decoder.getFileStats();

  // Update UI
  infoTotalFrames.textContent = totalFrames.toString();
  infoDuration.textContent = fileStats ? formatTime(fileStats.duration) : '-';
  infoFileSize.textContent = fileStats ? formatSize(fileStats.fileSize) : '-';

  renderTimelineKeyframes();
  renderChunkList();
  enableControls();
  hideLoading();

  // Display first frame
  if (totalFrames > 0) {
    await displayFrame(0);
    console.log(`Displayed first frame`);
  } else {
    console.error(`No frames found!`);
    alert(`No frames could be found in this file.`);
  }
}

// Playback loop
function playbackLoop(): void {
  if (!isPlaying || !decoder || totalFrames === 0) return;

  const now = performance.now();
  const elapsed = now - lastPlaybackTime;
  const header = decoder.getHeader()!;
  const frameInterval = (1000 / (header.frameRateNum / header.frameRateDen)) / playbackSpeed;

  if (elapsed >= frameInterval) {
    lastPlaybackTime = now;

    if (currentFrameIndex < totalFrames - 1) {
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
  if (!decoder || totalFrames === 0) return;

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
  if (!decoder) return 0;

  const keyframeIndices = decoder.getKeyframeIndices();
  for (let i = keyframeIndices.length - 1; i >= 0; i--) {
    if (keyframeIndices[i] < fromIndex) {
      return keyframeIndices[i];
    }
  }
  return 0;
}

// Find nearest keyframe after given index
function findNextKeyframe(fromIndex: number): number {
  if (!decoder) return totalFrames - 1;

  const keyframeIndices = decoder.getKeyframeIndices();
  for (const kfIndex of keyframeIndices) {
    if (kfIndex > fromIndex) {
      return kfIndex;
    }
  }
  return totalFrames - 1;
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

// URL loading
if (loadUrlBtn && urlInput) {
  loadUrlBtn.addEventListener('click', () => {
    const url = urlInput.value.trim();
    if (url) {
      loadUrl(url);
    }
  });

  urlInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
      const url = urlInput.value.trim();
      if (url) {
        loadUrl(url);
      }
    }
  });
}

// Play/pause
playBtn.addEventListener('click', () => {
  if (isPlaying) {
    stopPlayback();
  } else {
    // If at end, restart from beginning
    if (currentFrameIndex >= totalFrames - 1) {
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
  if (currentFrameIndex < totalFrames - 1) {
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
  if (totalFrames === 0) return;

  const rect = timelineClickable.getBoundingClientRect();
  const percent = (e.clientX - rect.left) / rect.width;
  const frameIndex = Math.floor(percent * totalFrames);

  stopPlayback();
  displayFrame(Math.max(0, Math.min(frameIndex, totalFrames - 1)));
});

// Keyboard shortcuts
document.addEventListener('keydown', (e) => {
  if (totalFrames === 0) return;

  // Ignore if typing in input
  if (e.target instanceof HTMLInputElement) return;

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
        if (currentFrameIndex < totalFrames - 1) displayFrame(currentFrameIndex + 1);
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
      displayFrame(totalFrames - 1);
      break;
  }
});

// Check for URL parameter
const urlParams = new URLSearchParams(window.location.search);
const sourceUrl = urlParams.get('url');
if (sourceUrl) {
  loadUrl(sourceUrl);
}
