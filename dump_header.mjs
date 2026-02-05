import { readFile } from 'fs/promises';

async function run() {
  try {
    const buffer = await readFile('debug_audio_new.qov');

    console.log('Hex:', buffer.subarray(0, 32).toString('hex'));
    console.log('Magic:', buffer.subarray(0, 4).toString());
    console.log('Version:', buffer[4]);
    console.log('Flags:', buffer[5]);
    console.log('Width:', buffer.readUInt16BE(6));
    console.log('Height:', buffer.readUInt16BE(8));
    console.log('FrameRate:', buffer.readUInt16BE(10));
    console.log('Frames:', buffer.readUInt32BE(12));

    // Check first chunk
    console.log('--- HEADER ---');
    console.log('Magic:', buffer.subarray(0, 4).toString());
    console.log('Version:', buffer[4]);
    console.log('Flags:', buffer[5]);
    console.log('Width:', buffer.readUInt16BE(6));
    console.log('Height:', buffer.readUInt16BE(8));
    console.log('FrameRate:', buffer.readUInt16BE(10));
    console.log('Frames:', buffer.readUInt32BE(12));
    console.log('AudioChannels:', buffer[16]);
    const audioRate = (buffer[17] << 16) | (buffer[18] << 8) | buffer[19];
    console.log('AudioRate:', audioRate);
    console.log('Colorspace:', buffer[20]);

  } catch (err) {
    console.error(err);
  }
}

run();
