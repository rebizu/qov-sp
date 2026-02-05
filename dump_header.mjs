import { readFile } from 'fs/promises';

async function run() {
  try {
    // Copy the file first to avoid path issues
    // await copyFile("C:\\Users\\RenéBrokholm\\Downloads\\recording-1770291584365.qov", "debug_new.qov");
    // Actually, I'll use the run_command to copy it first.
    const buffer = await readFile('debug_new.qov');

    console.log('Hex:', buffer.subarray(0, 32).toString('hex'));
    console.log('Magic:', buffer.subarray(0, 4).toString());
    console.log('Version:', buffer[4]);
    console.log('Flags:', buffer[5]);
    console.log('Width:', buffer.readUInt16BE(6));
    console.log('Height:', buffer.readUInt16BE(8));
    console.log('FrameRate:', buffer.readUInt16BE(10));
    console.log('Frames:', buffer.readUInt32BE(12));

    // Check first chunk
    const chunkType = buffer[16];
    console.log('First Chunk Type:', chunkType);
    console.log('First Chunk Size:', buffer.readUInt32BE(18)); // 16=type, 17=flags, 18=size

  } catch (err) {
    console.error(err);
  }
}

run();
