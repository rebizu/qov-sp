#!/usr/bin/env python3
"""
QOV File Analysis Tool
Analyzes QOV (Quite OK Video) files for format validation
"""

import sys
import struct
from typing import Tuple, List, Optional


class QovAnalyzer:
    def __init__(self, filename: str):
        self.filename = filename
        self.issues = []
        self.chunks = []

    def analyze(self) -> bool:
        """Analyze QOV file and return True if valid"""
        try:
            with open(self.filename, "rb") as f:
                data = f.read()

            print(f"=== Analyzing {self.filename} ===")
            print(f"File size: {len(data)} bytes\n")

            # Check minimum size
            if len(data) < 24:
                self.issues.append("❌ File too small (< 24 bytes)")
                return False

            # Parse header
            self.parse_header(data)

            # Parse chunks
            self.parse_chunks(data)

            # Check end marker
            self.check_end_marker(data)

            # Report results
            self.report_results()

            return len(self.issues) == 0

        except FileNotFoundError:
            print(f"❌ File not found: {self.filename}")
            return False
        except Exception as e:
            print(f"❌ Error analyzing file: {e}")
            return False

    def parse_header(self, data: bytes):
        """Parse and validate QOV header"""
        print("=== Header Analysis ===")

        # Parse fields
        magic = data[0:4].decode("ascii", errors="ignore")
        version = data[4]
        flags = data[5]
        width = (data[6] << 8) | data[7]
        height = (data[8] << 8) | data[9]
        fps_num = (data[10] << 8) | data[11]
        fps_den = (data[12] << 8) | data[13]
        total_frames = (data[14] << 24) | (data[15] << 16) | (data[16] << 8) | data[17]
        audio_channels = data[18]
        audio_rate = (data[19] << 16) | (data[20] << 8) | data[21]
        colorspace = data[22]
        reserved = data[23]

        # Check magic
        if magic != "qovf":
            self.issues.append(f"❌ Invalid magic bytes: {magic}")
        else:
            print(f"✓ Magic: {magic}")

        # Check version
        if version not in [0x01, 0x02]:
            self.issues.append(f"❌ Invalid version: 0x{version:02x}")
        else:
            print(f"✓ Version: 0x{version:02x}")

        # Check flags
        has_index = (flags & 0x04) != 0
        print(f"✓ Flags: 0x{flags:02x} (HAS_INDEX={has_index})")

        # Check dimensions
        if width <= 0 or width > 65535 or height <= 0 or height > 65535:
            self.issues.append(f"❌ Invalid dimensions: {width}x{height}")
        else:
            print(f"✓ Dimensions: {width}x{height}")

        # Check frame rate
        if fps_num == 0 or fps_den == 0:
            self.issues.append(f"❌ Invalid frame rate: {fps_num}/{fps_den}")
        else:
            print(f"✓ Frame rate: {fps_num}/{fps_den}")

        # Check total frames
        print(f"  Total frames: {total_frames}")

        # Check audio channels
        if audio_channels > 8:
            self.issues.append(
                f"❌ Invalid audio_channels: {audio_channels} (must be 0-8)"
            )
        else:
            print(f"✓ Audio channels: {audio_channels}")

        # Check audio rate
        if audio_rate > 16777215:
            self.issues.append(f"❌ Invalid audio_rate: {audio_rate}")
        else:
            print(f"✓ Audio rate: {audio_rate}")

        # Check colorspace
        valid_colorspaces = [0x00, 0x01, 0x02, 0x03, 0x10, 0x11, 0x12, 0x13]
        if colorspace not in valid_colorspaces:
            self.issues.append(f"❌ Invalid colorspace: 0x{colorspace:02x}")
        else:
            print(f"✓ Colorspace: 0x{colorspace:02x}")

        # Check reserved
        if reserved != 0:
            self.issues.append(f"❌ Invalid reserved byte: 0x{reserved:02x}")
        else:
            print(f"✓ Reserved: 0x{reserved:02x}")

    def parse_chunks(self, data: bytes):
        """Parse chunks from file"""
        print("\n=== Chunk Analysis ===")

        pos = 24
        chunk_count = 0
        chunk_names = {
            0x00: "SYNC",
            0x01: "KEYFRAME",
            0x02: "PFRAME",
            0x03: "BFRAME",
            0x10: "AUDIO",
            0xF0: "INDEX",
            0xFF: "END",
        }

        while pos + 10 <= len(data) and chunk_count < 20:
            chunk_type = data[pos]
            chunk_flags = data[pos + 1]
            chunk_size = (
                (data[pos + 2] << 24)
                | (data[pos + 3] << 16)
                | (data[pos + 4] << 8)
                | data[pos + 5]
            )
            timestamp = (
                (data[pos + 6] << 24)
                | (data[pos + 7] << 16)
                | (data[pos + 8] << 8)
                | data[pos + 9]
            )

            chunk_name = chunk_names.get(chunk_type, f"UNKNOWN(0x{chunk_type:02x})")

            print(f"Chunk {chunk_count}: {chunk_name}")
            print(f"  Offset: {pos} (0x{pos:02X})")
            print(f"  Type: 0x{chunk_type:02x}")
            print(f"  Flags: 0x{chunk_flags:02x}")
            print(f"  Size: {chunk_size}")
            print(f"  Timestamp: {timestamp}")

            # Validate chunk
            self.validate_chunk(chunk_type, chunk_flags, chunk_size, timestamp)

            # Store chunk info
            self.chunks.append(
                {
                    "type": chunk_type,
                    "flags": chunk_flags,
                    "size": chunk_size,
                    "timestamp": timestamp,
                    "offset": pos,
                }
            )

            pos += 10 + chunk_size
            chunk_count += 1

        if chunk_count >= 20:
            print(f"... (stopped at {chunk_count} chunks)")

    def validate_chunk(
        self, chunk_type: int, chunk_flags: int, chunk_size: int, timestamp: int
    ):
        """Validate individual chunk"""
        if chunk_type == 0x00:  # SYNC
            if chunk_size != 8:
                self.issues.append(
                    f"❌ SYNC chunk should have size 8, got {chunk_size}"
                )
            if chunk_flags != 0:
                self.issues.append(
                    f"❌ SYNC chunk flags should be 0, got 0x{chunk_flags:02x}"
                )

        elif chunk_type == 0xFF:  # END
            if chunk_size != 0:
                self.issues.append(f"❌ END chunk should have size 0, got {chunk_size}")
            if chunk_flags != 0:
                self.issues.append(
                    f"❌ END chunk flags should be 0, got 0x{chunk_flags:02x}"
                )
            if timestamp != 0:
                self.issues.append(
                    f"❌ END chunk timestamp should be 0, got {timestamp}"
                )

        elif chunk_type in [0x01, 0x02]:  # KEYFRAME, PFRAME
            if chunk_size == 0 or chunk_size > 0xFFFFFF:
                self.issues.append(f"❌ Invalid frame chunk size: {chunk_size}")

    def check_end_marker(self, data: bytes):
        """Check for valid end marker"""
        print("\n=== End Marker Check ===")

        # End marker should be: 0x00 0x00 0x00 0x00 0x00 0x00 0x00 0x01
        expected_end = bytes([0, 0, 0, 0, 0, 0, 0, 1])

        if len(data) < 8:
            self.issues.append("❌ File too small for end marker")
            return

        end_marker = data[-8:]

        if end_marker == expected_end:
            print("✓ Valid end marker: 0x00 0x00 0x00 0x00 0x00 0x00 0x00 0x01")
        else:
            print(f"❌ Invalid end marker: {' '.join(f'{b:02x}' for b in end_marker)}")
            print(f"  Expected: 0x00 0x00 0x00 0x00 0x00 0x00 0x00 0x01")
            self.issues.append("❌ Invalid end marker")

    def report_results(self):
        """Report analysis results"""
        print("\n" + "=" * 50)

        if len(self.issues) == 0:
            print("✓✓✓ FILE IS VALID ✓✓✓")
            print(f"Total chunks: {len(self.chunks)}")

            # Count chunk types
            chunk_counts = {}
            for chunk in self.chunks:
                chunk_name = chunk["type"]
                chunk_counts[chunk_name] = chunk_counts.get(chunk_name, 0) + 1

            chunk_type_names = {
                0x00: "SYNC",
                0x01: "KEYFRAME",
                0x02: "PFRAME",
                0xFF: "END",
            }

            print("\nChunk summary:")
            for chunk_type, count in sorted(chunk_counts.items()):
                name = chunk_type_names.get(chunk_type, f"Type 0x{chunk_type:02x}")
                print(f"  {name}: {count}")

        else:
            print("❌❌❌ FILE IS INVALID ❌❌❌")
            print(f"Found {len(self.issues)} issue(s):")
            for issue in self.issues:
                print(f"  • {issue}")


def main():
    if len(sys.argv) < 2:
        print("Usage: python analyze_qov.py <filename.qov>")
        print("\nQOV File Analysis Tool")
        print(
            "Analyzes QOV files for format validation according to QOV specification v1.0"
        )
        sys.exit(1)

    filename = sys.argv[1]
    analyzer = QovAnalyzer(filename)

    is_valid = analyzer.analyze()

    sys.exit(0 if is_valid else 1)


if __name__ == "__main__":
    main()
