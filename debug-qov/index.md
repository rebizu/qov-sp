# QOV Debug Scripts

This directory contains various scripts for debugging, testing, and diagnosing QOV files and the encoder/decoder implementation.

## 📂 diagnose
Scripts for analyzing QOV files.

- **`diagnose-qov.ts`**
  - **Type:** TypeScript (Main Diagnostic Tool)
  - **Purpose:** Analyzing specific QOV frames for artifacts, black pixels, and luminance/color statistics.
  - **Features:**
    - Checks for black pixels (RGB=0,0,0) and dark pixels (<20).
    - Analyzes luminance distribution.
    - Decodes and analyzes internal YUV planes (Y, U, V stats).
    - Can verify YUV-to-RGB conversion accuracy.
- **`diagnose-qov.js` / `diagnose-qov.mjs`**
    - **Type:** JavaScript
    - **Purpose:** Compiled/bundled versions of the diagnostic tool for use in environments without TS support.

## 📂 debug
General debugging scripts for lower-level protocol analysis.

- **`debug-qov-index.ts`**
    - **Type:** TypeScript
    - **Purpose:** Debugging the P-frame INDEX table state and synchronization.
    - **How it works:**
        - Manually implements a partial decoder.
        - Tracks the state of the INDEX table (64 slots) for Y, U, and V planes.
        - Detects when the stream references an uninitialized INDEX slot (which causes black artifacts).
        - Reports exactly which frame, plane, and index slot is desynchronized.
- **`debug-qov-v2-index.cjs`**
    - **Type:** CommonJS
    - **Purpose:** Similar to `debug-qov-index.ts` but specifically updated for QOV **v2** file format.
    - **Features:**
        - Handles QOV v2 header (magic `qovf`, extra audio metadata).
        - Skips over non-video chunks (Audio, etc).
        - Performs the same INDEX table synchronization checks.
- **`debug-simple.cjs`**
    - **Type:** CommonJS
    - **Purpose:** A bare-bones, dependency-free decoder script.
    - **Use Case:** "Sanity check" script to just verify that frames can be parsed and decoded without crashing, without the overhead of the full `QovDecoder` class. Useful for isolating if a crash is in the class structure or the raw data parsing.

## 📂 repro
Scripts that reproduce specific bugs or demonstrate protocol flaws.

- **`proof-of-bug.cjs`**
    - **Type:** CommonJS
    - **Purpose:** Demonstrates the logic flaw in the Encoder's INDEX update mechanism.
    - **Method:**
        - Simulates a specific sequence of pixel updates (TDIFF, TLUMA, etc).
        - Comparing the state of a "Mock Encoder" vs "Mock Decoder" to prove they diverge (desynchronize) when handling specific INDEX opcodes.
- **`real-desync.cjs`**
    - **Type:** CommonJS
    - **Purpose:** A more complex scenario proving desync caused by **Hash Collisions**.
    - **Method:** Shows how if two different values hash to the same slot (0), the encoder and decoder might disagree on what is valid in that slot, leading to corruption.
- **`verify-desync.cjs`**
    - **Type:** CommonJS
    - **Purpose:** Validates whether the Encoder/Decoder logic is synchronized.
    - **Method:** Simulates a shared pixel stream and asserts that the final Index Table state is identical for both. Used to verify fixes (e.g., ensuring `INDEX` opcode does NOT update the table).

## 📂 tests
Standalone tests for specific functionality.

- **`test-yuv-roundtrip.mjs`**
    - **Type:** ES Module
    - **Purpose:** Verifies YUV <-> RGB conversion accuracy.
    - **Method:** Takes common colors (Red, Green, Blue, White, Black) and effectively runs `RGB -> YUV -> RGB` and measures the drift/error to ensure it is within acceptable lossy limits.
- **`test-bright-pixels.mjs`**
    - **Type:** ES Module
    - **Purpose:** Tests for integer overflow/wrapping.
    - **Method:** Feeds extremely bright/saturated values (e.g. 255,255,255) into the YUV conversion to ensure they clamp correctly (stop at 255) rather than wrapping around to 0 (black).
- **`test-hash-collision.cjs`**
    - **Type:** CommonJS
    - **Purpose:** Analyzes the `(val * 3) % 64` hash function.
    - **Output:** Prints all collision pairs (values that map to the same slot) to understand the probability of index collisions.
- **`test-yuv-fix.mjs`**
    - **Type:** ES Module
    - **Purpose:** Integration test for black pixel artifacts.
    - **Method:** Loads a real QOV file and scans decoded P-frames. If it finds pixels with `RGB=0,0,0` (black dots), it reports a failure. Used to confirm if the "Index Table Persistence" fix is working on real data.
- **`test-yuv-fix-bundled.mjs`**
    - **Type:** ES Module
    - **Purpose:** A simple script to verify the build process for the web-based diagnosis tool produced a valid output.
