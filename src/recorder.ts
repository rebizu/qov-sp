// QOV Recorder - Camera capture and encoding

import { QovEncoder } from './qov-encoder';
import { QOV_FLAG_HAS_INDEX } from './qov-types';

// DOM Elements
const preview = document.getElementById('preview') as HTMLVideoElement;
const captureCanvas = document.getElementById('captureCanvas') as HTMLCanvasElement;
const startBtn = document.getElementById('startBtn') as HTMLButtonElement;
const downloadBtn = document.getElementById('downloadBtn') as HTMLButtonElement;
const cameraSelect = document.getElementById('cameraSelect') as HTMLSelectElement;
const resolutionSelect = document.getElementById('resolutionSelect') as HTMLSelectElement;
const fpsSelect = document.getElementById('fpsSelect') as HTMLSelectElement;
const keyframeIntervalSelect = document.getElementById('keyframeInterval') as HTMLSelectElement;
const recordingIndicator = document.getElementById('recordingIndicator') as HTMLDivElement;

// Stats elements
const statDuration = document.getElementById('statDuration') as HTMLSpanElement;
const statFrames = document.getElementById('statFrames') as HTMLSpanElement;
const statKeyframes = document.getElementById('statKeyframes') as HTMLSpanElement;
const statSize = document.getElementById('statSize') as HTMLSpanElement;
const statActualFps = document.getElementById('statActualFps') as HTMLSpanElement;

// State
let mediaStream: MediaStream | null = null;
let encoder: QovEncoder | null = null;
let isRecording = false;
let animationFrameId: number | null = null;
let recordingStartTime = 0;
let frameCount = 0;
let keyframeCount = 0;
let lastFrameTime = 0;
let encodedData: Uint8Array | null = null;

// Log to console and optionally show alert
function log(message: string, isError = false): void {
  const prefix = isError ? '[ERROR]' : '[INFO]';
  console.log(`${prefix} ${message}`);
}

// Get available cameras
async function getCameras(): Promise<MediaDeviceInfo[]> {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const cameras = devices.filter(d => d.kind === 'videoinput');
    log(`Found ${cameras.length} camera(s)`);
    cameras.forEach((cam, i) => {
      log(`  Camera ${i}: ${cam.label || 'Unnamed'} (${cam.deviceId.substring(0, 8)}...)`);
    });
    return cameras;
  } catch (err) {
    log(`Failed to enumerate devices: ${err}`, true);
    return [];
  }
}

// Populate camera dropdown
async function populateCameras(): Promise<void> {
  const cameras = await getCameras();
  cameraSelect.innerHTML = '';

  if (cameras.length === 0) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = 'No cameras found';
    cameraSelect.appendChild(option);
    return;
  }

  cameras.forEach((camera, index) => {
    const option = document.createElement('option');
    option.value = camera.deviceId;
    option.textContent = camera.label || `Camera ${index + 1}`;
    cameraSelect.appendChild(option);
  });
}

// Stop existing media stream
function stopStream(): void {
  if (mediaStream) {
    mediaStream.getTracks().forEach(track => {
      track.stop();
      log(`Stopped track: ${track.kind}`);
    });
    mediaStream = null;
  }
}

// Start camera preview
async function startPreview(): Promise<void> {
  const [width, height] = resolutionSelect.value.split('x').map(Number);
  const frameRate = parseInt(fpsSelect.value);
  const deviceId = cameraSelect.value;

  log(`Starting preview: ${width}x${height} @ ${frameRate}fps, device: ${deviceId || 'default'}`);

  // Stop existing stream
  stopStream();

  const constraints: MediaStreamConstraints = {
    video: {
      width: { ideal: width },
      height: { ideal: height },
      frameRate: { ideal: frameRate },
    },
    audio: false,
  };

  // Only add deviceId constraint if we have a specific one
  if (deviceId) {
    (constraints.video as MediaTrackConstraints).deviceId = { exact: deviceId };
  }

  try {
    mediaStream = await navigator.mediaDevices.getUserMedia(constraints);
    log('Got media stream successfully');

    preview.srcObject = mediaStream;

    // Wait for video to be ready
    await new Promise<void>((resolve) => {
      preview.onloadedmetadata = () => {
        log(`Video metadata loaded: ${preview.videoWidth}x${preview.videoHeight}`);
        resolve();
      };
    });

    await preview.play();
    log('Video playing');

    // Set canvas size to match actual video dimensions
    const track = mediaStream.getVideoTracks()[0];
    const settings = track.getSettings();
    const actualWidth = settings.width || preview.videoWidth || width;
    const actualHeight = settings.height || preview.videoHeight || height;

    captureCanvas.width = actualWidth;
    captureCanvas.height = actualHeight;
    log(`Canvas size set to: ${actualWidth}x${actualHeight}`);

    startBtn.disabled = false;
  } catch (err) {
    log(`Failed to start camera: ${err}`, true);

    // Try without specific device ID
    if (deviceId) {
      log('Retrying without specific device ID...');
      cameraSelect.value = '';
      try {
        mediaStream = await navigator.mediaDevices.getUserMedia({
          video: {
            width: { ideal: width },
            height: { ideal: height },
            frameRate: { ideal: frameRate },
          },
          audio: false,
        });

        preview.srcObject = mediaStream;
        await preview.play();

        captureCanvas.width = preview.videoWidth || width;
        captureCanvas.height = preview.videoHeight || height;

        startBtn.disabled = false;
        log('Fallback camera started successfully');

        // Re-populate cameras now that we have permission
        await populateCameras();
      } catch (fallbackErr) {
        log(`Fallback also failed: ${fallbackErr}`, true);
        alert(`Camera access failed: ${fallbackErr}\n\nPlease ensure:\n1. Camera permissions are granted\n2. No other app is using the camera\n3. You're using HTTPS or localhost`);
      }
    } else {
      alert(`Camera access failed: ${err}\n\nPlease ensure:\n1. Camera permissions are granted\n2. No other app is using the camera\n3. You're using HTTPS or localhost`);
    }
  }
}

// Format duration as MM:SS
function formatDuration(seconds: number): string {
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

// Update stats display
function updateStats(): void {
  const elapsed = (performance.now() - recordingStartTime) / 1000;
  statDuration.textContent = formatDuration(elapsed);
  statFrames.textContent = frameCount.toString();
  statKeyframes.textContent = keyframeCount.toString();

  // Estimate file size (rough estimate based on frame count)
  const avgBytesPerFrame = 5000; // Conservative estimate
  const estimatedSize = frameCount * avgBytesPerFrame;
  statSize.textContent = formatSize(estimatedSize);

  // Calculate actual FPS
  if (elapsed > 0) {
    const actualFps = frameCount / elapsed;
    statActualFps.textContent = actualFps.toFixed(1);
  }
}

// Capture a single frame
function captureFrame(): void {
  if (!isRecording || !mediaStream || !encoder) return;

  const ctx = captureCanvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return;

  const now = performance.now();
  const targetFps = parseInt(fpsSelect.value);
  const frameInterval = 1000 / targetFps;
  const keyframeInterval = parseInt(keyframeIntervalSelect.value);

  // Throttle to target FPS
  if (now - lastFrameTime < frameInterval * 0.9) {
    animationFrameId = requestAnimationFrame(captureFrame);
    return;
  }
  lastFrameTime = now;

  // Draw video frame to canvas
  ctx.drawImage(preview, 0, 0, captureCanvas.width, captureCanvas.height);

  // Get pixel data
  const imageData = ctx.getImageData(0, 0, captureCanvas.width, captureCanvas.height);
  const timestamp = Math.floor((now - recordingStartTime) * 1000); // microseconds

  // Encode frame
  const isKeyframe = frameCount % keyframeInterval === 0;
  if (isKeyframe) {
    encoder.encodeKeyframe(imageData.data, timestamp);
    keyframeCount++;
  } else {
    encoder.encodePFrame(imageData.data, timestamp);
  }

  frameCount++;
  updateStats();

  // Continue recording
  animationFrameId = requestAnimationFrame(captureFrame);
}

// Start recording
function startRecording(): void {
  if (!mediaStream) {
    alert('No camera stream available');
    return;
  }

  const width = captureCanvas.width;
  const height = captureCanvas.height;
  const frameRate = parseInt(fpsSelect.value);

  log(`Starting recording: ${width}x${height} @ ${frameRate}fps`);

  // Initialize encoder
  encoder = new QovEncoder(width, height, frameRate, 1, QOV_FLAG_HAS_INDEX);
  encoder.writeHeader();

  // Reset state
  frameCount = 0;
  keyframeCount = 0;
  recordingStartTime = performance.now();
  lastFrameTime = 0;
  isRecording = true;

  // Update UI
  startBtn.textContent = 'Stop Recording';
  startBtn.classList.add('recording');
  recordingIndicator.classList.add('active');
  downloadBtn.disabled = true;
  cameraSelect.disabled = true;
  resolutionSelect.disabled = true;
  fpsSelect.disabled = true;
  keyframeIntervalSelect.disabled = true;

  // Start capture loop
  captureFrame();
}

// Stop recording
function stopRecording(): void {
  isRecording = false;
  log(`Stopping recording. Frames captured: ${frameCount}`);

  if (animationFrameId) {
    cancelAnimationFrame(animationFrameId);
    animationFrameId = null;
  }

  if (encoder) {
    encodedData = encoder.finish();
    statSize.textContent = formatSize(encodedData.length);
    log(`Encoded file size: ${formatSize(encodedData.length)}`);
  }

  // Update UI
  startBtn.textContent = 'Start Recording';
  startBtn.classList.remove('recording');
  recordingIndicator.classList.remove('active');
  downloadBtn.disabled = false;
  cameraSelect.disabled = false;
  resolutionSelect.disabled = false;
  fpsSelect.disabled = false;
  keyframeIntervalSelect.disabled = false;
}

// Download QOV file
function downloadQov(): void {
  if (!encodedData) return;

  const blob = new Blob([new Uint8Array(encodedData)], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);

  const a = document.createElement('a');
  a.href = url;
  a.download = `recording-${Date.now()}.qov`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);

  log(`Downloaded: ${a.download}`);
}

// Event listeners
startBtn.addEventListener('click', () => {
  if (isRecording) {
    stopRecording();
  } else {
    startRecording();
  }
});

downloadBtn.addEventListener('click', downloadQov);

cameraSelect.addEventListener('change', startPreview);
resolutionSelect.addEventListener('change', startPreview);
fpsSelect.addEventListener('change', () => {
  if (!isRecording) {
    startPreview();
  }
});

// Cleanup on page unload
window.addEventListener('beforeunload', () => {
  log('Page unloading, stopping streams...');
  stopStream();
});

// Initialize
async function init(): Promise<void> {
  log('Initializing QOV Recorder...');

  // Check if getUserMedia is available
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    alert('Camera API not available. Please use a modern browser with HTTPS or localhost.');
    return;
  }

  // Stop any existing streams first (cleanup from previous session)
  if (mediaStream) {
    log('Stopping existing stream...');
    mediaStream.getTracks().forEach(track => track.stop());
    mediaStream = null;
  }

  // Also clear the video element
  if (preview.srcObject) {
    const oldStream = preview.srcObject as MediaStream;
    oldStream.getTracks().forEach(track => track.stop());
    preview.srcObject = null;
    log('Cleared previous video source');
  }

  try {
    // Request camera permission first with minimal constraints
    log('Requesting camera permission...');
    const initialStream = await navigator.mediaDevices.getUserMedia({
      video: true,
      audio: false
    });
    log('Permission granted');

    // Keep this stream for preview instead of stopping it
    mediaStream = initialStream;
    preview.srcObject = mediaStream;

    await new Promise<void>((resolve) => {
      preview.onloadedmetadata = () => {
        log(`Video metadata loaded: ${preview.videoWidth}x${preview.videoHeight}`);
        resolve();
      };
    });

    await preview.play();

    // Set canvas to actual video size
    captureCanvas.width = preview.videoWidth;
    captureCanvas.height = preview.videoHeight;

    log(`Camera ready: ${preview.videoWidth}x${preview.videoHeight}`);
    startBtn.disabled = false;

    // Now enumerate devices (labels will be available after permission)
    await populateCameras();

    log('Initialization complete');
  } catch (err: unknown) {
    log(`Initialization failed: ${err}`, true);

    const errorMessage = err instanceof Error ? err.message : String(err);
    const errorName = err instanceof Error ? err.name : 'Unknown';

    if (errorName === 'NotReadableError') {
      alert(`Camera is in use by another application.\n\nPlease:\n1. Close other apps using the camera (Zoom, Teams, Discord, etc.)\n2. Close other browser tabs using the camera\n3. Refresh this page`);
    } else if (errorName === 'NotAllowedError') {
      alert(`Camera permission denied.\n\nPlease allow camera access and refresh the page.`);
    } else if (errorName === 'NotFoundError') {
      alert(`No camera found.\n\nPlease connect a camera and refresh the page.`);
    } else {
      alert(`Failed to access camera: ${errorMessage}\n\nError type: ${errorName}`);
    }
  }
}

init();
