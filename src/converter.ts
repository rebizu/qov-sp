// Video to QOV Converter - Uses native browser video decoding

import { QovEncoder } from './qov-encoder';
import { QOV_FLAG_HAS_INDEX, QOV_FLAG_HAS_ALPHA } from './qov-types';

// DOM Elements
const previewCanvas = document.getElementById('previewCanvas') as HTMLCanvasElement;
const dropZone = document.getElementById('dropZone') as HTMLDivElement;
const fileInput = document.getElementById('fileInput') as HTMLInputElement;
const convertBtn = document.getElementById('convertBtn') as HTMLButtonElement;
const downloadBtn = document.getElementById('downloadBtn') as HTMLButtonElement;
const keyframeIntervalSelect = document.getElementById('keyframeInterval') as HTMLSelectElement;
const targetFpsSelect = document.getElementById('targetFps') as HTMLSelectElement;
const resolutionSelect = document.getElementById('resolution') as HTMLSelectElement;
const colorspaceSelect = document.getElementById('colorspace') as HTMLSelectElement;
const flagIndexCheckbox = document.getElementById('flagIndex') as HTMLInputElement;
const flagAlphaCheckbox = document.getElementById('flagAlpha') as HTMLInputElement;
const startTimeInput = document.getElementById('startTime') as HTMLInputElement;
const endTimeInput = document.getElementById('endTime') as HTMLInputElement;
const maxFramesInput = document.getElementById('maxFrames') as HTMLInputElement;

// Stats elements
const statFileName = document.getElementById('statFileName') as HTMLSpanElement;
const statFileSize = document.getElementById('statFileSize') as HTMLSpanElement;
const statResolution = document.getElementById('statResolution') as HTMLSpanElement;
const statDuration = document.getElementById('statDuration') as HTMLSpanElement;
const statFrames = document.getElementById('statFrames') as HTMLSpanElement;
const statOutputSize = document.getElementById('statOutputSize') as HTMLSpanElement;
const statCompression = document.getElementById('statCompression') as HTMLSpanElement;
const statOutputRes = document.getElementById('statOutputRes') as HTMLSpanElement;
const statEstFrames = document.getElementById('statEstFrames') as HTMLSpanElement;
const statEstDuration = document.getElementById('statEstDuration') as HTMLSpanElement;
const progressFill = document.getElementById('progressFill') as HTMLDivElement;
const progressText = document.getElementById('progressText') as HTMLDivElement;
const logContainer = document.getElementById('logContainer') as HTMLDivElement;

const ctx = previewCanvas.getContext('2d', { willReadFrequently: true })!;

// Create hidden video element for decoding
const video = document.createElement('video');
video.muted = true;
video.playsInline = true;
video.preload = 'auto';

// State
let sourceFile: File | null = null;
let videoUrl: string | null = null;
let encodedData: Uint8Array | null = null;
let isConverting = false;

// Logging
function log(message: string, type: 'info' | 'error' | 'success' = 'info'): void {
  console.log(`[${type.toUpperCase()}] ${message}`);
  const entry = document.createElement('div');
  entry.className = `log-entry ${type}`;
  entry.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
  logContainer.appendChild(entry);
  logContainer.scrollTop = logContainer.scrollHeight;
}

// Format file size
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

// Format duration
function formatDuration(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

// Load video file
async function loadFile(file: File): Promise<void> {
  log(`Loading file: ${file.name}`);
  sourceFile = file;

  // Clean up previous URL
  if (videoUrl) {
    URL.revokeObjectURL(videoUrl);
  }

  statFileName.textContent = file.name.length > 20 ? file.name.substring(0, 17) + '...' : file.name;
  statFileSize.textContent = formatSize(file.size);

  // Create blob URL for video
  videoUrl = URL.createObjectURL(file);
  video.src = videoUrl;

  try {
    // Wait for video metadata to load
    await new Promise<void>((resolve, reject) => {
      video.onloadedmetadata = () => {
        log(`Video metadata loaded`);
        resolve();
      };
      video.onerror = () => {
        reject(new Error(`Failed to load video: ${video.error?.message || 'Unknown error'}`));
      };
      // Timeout after 10 seconds
      setTimeout(() => reject(new Error('Timeout loading video')), 10000);
    });

    // Set canvas size
    previewCanvas.width = video.videoWidth;
    previewCanvas.height = video.videoHeight;

    log(`Video: ${video.videoWidth}x${video.videoHeight}, duration: ${formatDuration(video.duration)}`);
    statResolution.textContent = `${video.videoWidth}x${video.videoHeight}`;
    statDuration.textContent = formatDuration(video.duration);

    // Update end time input max and placeholder
    endTimeInput.max = video.duration.toString();
    endTimeInput.placeholder = `0 - ${video.duration.toFixed(1)}`;

    // Show first frame preview
    video.currentTime = 0;
    await new Promise<void>((resolve) => {
      video.onseeked = () => {
        ctx.drawImage(video, 0, 0);
        resolve();
      };
    });

    dropZone.classList.add('hidden');
    convertBtn.disabled = false;
    downloadBtn.disabled = true;
    encodedData = null;

    // Update output preview
    updateOutputPreview();

    log('Video loaded successfully', 'success');
    log(`Ready to convert. Click "Convert to QOV" to begin.`);

  } catch (err) {
    log(`Failed to load video: ${err}`, 'error');
    alert(`Failed to load video file.\n\nThis might happen if:\n1. The file format is not supported by the browser\n2. The file is corrupted\n\nTry converting to MP4 first using another tool.`);
  }
}

// Extract frame at current video time
function extractFrame(): Uint8ClampedArray {
  ctx.drawImage(video, 0, 0, previewCanvas.width, previewCanvas.height);
  const imageData = ctx.getImageData(0, 0, previewCanvas.width, previewCanvas.height);
  return imageData.data;
}

// Calculate output dimensions based on resolution setting
function calculateOutputDimensions(): { width: number; height: number } {
  if (!video.videoWidth || !video.videoHeight) {
    return { width: 0, height: 0 };
  }

  const resValue = resolutionSelect.value;
  const srcWidth = video.videoWidth;
  const srcHeight = video.videoHeight;

  // Check if it's a percentage (decimal) or fixed height
  const numValue = parseFloat(resValue);

  if (numValue <= 1) {
    // Percentage scale
    return {
      width: Math.round(srcWidth * numValue),
      height: Math.round(srcHeight * numValue),
    };
  } else {
    // Fixed height (e.g., 720p)
    const targetHeight = numValue;
    const scale = targetHeight / srcHeight;
    return {
      width: Math.round(srcWidth * scale),
      height: Math.round(srcHeight * scale),
    };
  }
}

// Update output preview stats based on current settings
function updateOutputPreview(): void {
  if (!video.videoWidth || !video.videoHeight) {
    statOutputRes.textContent = '-';
    statEstFrames.textContent = '-';
    statEstDuration.textContent = '-';
    return;
  }

  const { width, height } = calculateOutputDimensions();
  statOutputRes.textContent = `${width}x${height}`;

  const targetFpsValue = parseInt(targetFpsSelect.value);
  const targetFps = targetFpsValue || 30;

  const startTime = parseFloat(startTimeInput.value) || 0;
  const endTimeValue = parseFloat(endTimeInput.value);
  const endTime = endTimeValue > 0 ? Math.min(endTimeValue, video.duration) : video.duration;
  const maxFrames = parseInt(maxFramesInput.value) || 0;

  const duration = Math.max(0, endTime - startTime);
  let estFrames = Math.floor(duration * targetFps);
  if (maxFrames > 0) {
    estFrames = Math.min(estFrames, maxFrames);
  }

  statEstFrames.textContent = estFrames.toString();
  statEstDuration.textContent = formatDuration(duration);
}

// Convert video to QOV
async function convertToQov(): Promise<void> {
  if (!video.videoWidth || !video.videoHeight) {
    log('No video loaded', 'error');
    return;
  }

  if (isConverting) {
    log('Conversion already in progress', 'error');
    return;
  }

  isConverting = true;

  // Get all settings
  const keyframeInterval = parseInt(keyframeIntervalSelect.value);
  const targetFpsValue = parseInt(targetFpsSelect.value);
  const colorspace = parseInt(colorspaceSelect.value);
  const startTime = parseFloat(startTimeInput.value) || 0;
  const endTimeValue = parseFloat(endTimeInput.value);
  const endTime = endTimeValue > 0 ? Math.min(endTimeValue, video.duration) : video.duration;
  const maxFrames = parseInt(maxFramesInput.value) || 0;

  // Build flags
  let flags = 0;
  if (flagIndexCheckbox.checked) flags |= QOV_FLAG_HAS_INDEX;
  if (flagAlphaCheckbox.checked) flags |= QOV_FLAG_HAS_ALPHA;

  // Calculate output dimensions
  const { width: outputWidth, height: outputHeight } = calculateOutputDimensions();

  // Set canvas size to output dimensions
  previewCanvas.width = outputWidth;
  previewCanvas.height = outputHeight;

  // Estimate source fps (default to 30 if unknown)
  const sourceFps = 30;
  const targetFps = targetFpsValue || sourceFps;

  const duration = endTime - startTime;
  let estimatedFrames = Math.floor(duration * targetFps);
  if (maxFrames > 0) {
    estimatedFrames = Math.min(estimatedFrames, maxFrames);
  }

  log(`Converting to QOV...`);
  log(`Resolution: ${outputWidth}x${outputHeight}`);
  log(`Frame rate: ${targetFps} fps, keyframe interval: ${keyframeInterval}`);
  log(`Time range: ${startTime.toFixed(2)}s - ${endTime.toFixed(2)}s`);
  const isYuv = colorspace >= 0x10 && colorspace <= 0x13;
  log(`Colorspace: 0x${colorspace.toString(16).padStart(2, '0')} (${isYuv ? 'YUV' : 'RGB'}), Flags: 0x${flags.toString(16).padStart(2, '0')}`);
  log(`Estimated frames: ${estimatedFrames}`);

  convertBtn.disabled = true;
  downloadBtn.disabled = true;
  progressFill.style.width = '0%';
  progressText.textContent = 'Starting conversion...';

  // Create encoder with all parameters
  const encoder = new QovEncoder(
    outputWidth,
    outputHeight,
    targetFps,
    1,
    flags,
    colorspace
  );
  encoder.writeHeader();

  const frameInterval = 1 / targetFps;
  let frameCount = 0;
  let keyframeCount = 0;

  // Seek through video and extract frames
  for (let time = startTime; time < endTime; time += frameInterval) {
    // Check max frames limit
    if (maxFrames > 0 && frameCount >= maxFrames) {
      log(`Reached max frames limit (${maxFrames})`, 'info');
      break;
    }

    // Seek to time
    video.currentTime = time;

    // Wait for seek to complete
    await new Promise<void>((resolve) => {
      const onSeeked = () => {
        video.removeEventListener('seeked', onSeeked);
        resolve();
      };
      video.addEventListener('seeked', onSeeked);
    });

    // Extract frame (scaled to output dimensions)
    const pixels = extractFrame();
    const timestamp = Math.floor((time - startTime) * 1000000); // microseconds from start

    // Encode frame
    const isKeyframe = frameCount % keyframeInterval === 0;
    if (isKeyframe) {
      encoder.encodeKeyframe(pixels, timestamp);
      keyframeCount++;
    } else {
      encoder.encodePFrame(pixels, timestamp);
    }

    frameCount++;

    // Update progress
    const progress = ((time - startTime) / duration) * 100;
    progressFill.style.width = `${progress}%`;
    progressText.textContent = `Converting: frame ${frameCount} / ~${estimatedFrames}`;
    statFrames.textContent = `${frameCount} (${keyframeCount} KF)`;

    // Yield to UI every 5 frames
    if (frameCount % 5 === 0) {
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  }

  // Finish encoding
  encodedData = encoder.finish();

  // Update stats
  statFrames.textContent = `${frameCount} (${keyframeCount} keyframes)`;
  statOutputSize.textContent = formatSize(encodedData.length);

  const compressionRatio = sourceFile ? (sourceFile.size / encodedData.length).toFixed(2) : '-';
  statCompression.textContent = `${compressionRatio}x`;

  progressFill.style.width = '100%';
  progressText.textContent = 'Conversion complete!';

  log(`Conversion complete!`, 'success');
  log(`Output: ${frameCount} frames, ${formatSize(encodedData.length)}`);
  log(`Final resolution: ${outputWidth}x${outputHeight}`);

  downloadBtn.disabled = false;
  convertBtn.disabled = false;
  isConverting = false;
}

// Download QOV file
function downloadQov(): void {
  if (!encodedData || !sourceFile) return;

  const blob = new Blob([new Uint8Array(encodedData)], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);

  const baseName = sourceFile.name.replace(/\.[^/.]+$/, '');
  const a = document.createElement('a');
  a.href = url;
  a.download = `${baseName}.qov`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);

  log(`Downloaded: ${a.download}`, 'success');
}

// Event listeners
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

convertBtn.addEventListener('click', convertToQov);
downloadBtn.addEventListener('click', downloadQov);

// Settings change listeners - update preview
resolutionSelect.addEventListener('change', updateOutputPreview);
targetFpsSelect.addEventListener('change', updateOutputPreview);
startTimeInput.addEventListener('input', updateOutputPreview);
endTimeInput.addEventListener('input', updateOutputPreview);
maxFramesInput.addEventListener('input', updateOutputPreview);

// Initialize
log('Video to QOV Converter ready');
log('Supported formats: MP4, WebM, MPEG, and others supported by your browser');
log('Drop a video file to begin');
