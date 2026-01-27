# QOV Encoder Validation Plan

## 📋 Executive Summary

The C# encoder produces invalid QOV files with corrupted header fields, despite apparent fixes to the source code. A comprehensive validation framework has been created, but complete encoder comparison cannot proceed until the C# encoder corruption is resolved and a TypeScript CLI encoder is implemented.

## 🔍 Current Status

### Completed Work
- ✅ Created QOV file format validator (`analyze_qov.py`)
- ✅ Created encoder comparison framework (`validate_encoders.py`)
- ✅ Identified C# encoder header corruption issues
- ✅ Applied source code fixes to encoder
- ✅ Fixed test program to accept custom filenames
- ✅ Fixed DVD logo video generation

### Issues Identified
- ❌ **C# Encoder Header Corruption**: Audio channels field = 0xF0 (should be 0x00), Reserved byte = 0x54 (should be 0x00)
- ❌ **Source vs. Binary Mismatch**: Source code shows correct fixes (0x00) but compiled DLL produces 0xF0/0x54
- ❌ **Missing TypeScript CLI**: Need command-line version of TypeScript encoder for comparison

## 🛠️ Technical Issues

### C# Encoder Corruption Problem

**Symptoms:**
- Source code writes `_writer.Write((byte)0)` for audio channels and reserved fields
- Compiled output shows 0xF0 (audio channels) and 0x54 (reserved)
- File size and structure are valid, but specific header bytes are corrupted

**Investigation Steps:**
1. ✅ Verified source code has correct `_writer.Write((byte)0)` calls
2. ✅ Performed clean rebuilds with `dotnet clean && dotnet build`
3. ✅ Checked for duplicate `QovEncoder.cs` files (found only one)
4. ✅ Examined DLL timestamps and rebuild sequences

**Remaining Investigation:**
- Check if there are multiple encoder implementations or inheritance hierarchies
- Verify which actual encoder class is being instantiated
- Check for pre-compiled or cached DLL references
- Examine build artifact contents vs. source code

### TypeScript Encoder CLI Needed

**Current State:**
- TypeScript encoder (`src/qov-encoder.ts`) works in web environment
- No command-line interface exists
- Cannot run automated comparisons without CLI version

## 📊 Validation Results

### Sample C# Encoder Output Analysis

```
File: csharp_output.qov
Magic: qovf ✓
Version: 0x02 ✓  
Dimensions: 640x480 ✓
FPS: 30/1 ✓
Frames: 150 ✓
Audio Channels: 240 ❌ (should be 0)
Audio Rate: 0 ✓
Colorspace: 0x00 ✓
Reserved: 0x54 ❌ (should be 0)
```

### File Structure

Valid header bytes:
- Offsets 0x00-0x11: Correct (magic, version, flags, dimensions, FPS, frames)
- Offset 0x12 (audio_channels): **0xF0** instead of 0x00
- Offset 0x17 (reserved): **0x54** instead of 0x00

Chunk structure appears corrupted as well:
- SYNC chunks with wrong sizes (0 instead of 8)
- Invalid chunk detection/parsing

## 🔧 Required Fixes

### Priority 1: C# Encoder Header Corruption (CRITICAL)

**Investigation Steps:**
1. **Verify Actual Compiled Code:**
   - Decompile `QovLibrary.dll` source
   - Verify `WriteHeader()` method bytecode
   - Check if source changes were actually compiled

2. **Check Build Process:**
   - Verify build cache not using old artifacts
   - Check project file references and dependencies
   - Ensure `QovLibrary.csproj` references the correct `QovEncoder.cs`

3. **Examine Runtime Behavior:**
   - Add debug logging to `WriteHeader()` method
   - Log byte-by-byte what's being written
   - Verify `_writer.Write()` calls are actually executing

4. **Alternative Implementation:**
   - If corruption persists, use stream-based header writing
   - Write header as raw bytes array instead of method calls
   - Verify BinaryWriter endianness settings

**Expected Fix Approach:**
```csharp
// Direct byte array approach (if method calls still fail)
byte[] headerBytes = new byte[24] {
    0x71, 0x6F, 0x76, 0x66, // "qovf"
    0x02,                    // version
    flags,                  // flags
    (byte)(width >> 8), (byte)width,    // width big-endian
    (byte)(height >> 8), (byte)height,  // height big-endian
    ... // rest of fields
};
_writer.Write(headerBytes);
```

### Priority 2: TypeScript CLI Encoder

**Implementation Steps:**
1. Create `src/encoder-cli.ts` with command-line parsing
2. Implement DVD logo pattern generation (same as C# test)
3. Add file output functionality
4. Make CLI executable via Node.js

**Required Interface:**
```bash
# Usage
npx ts-node src/encoder-cli.ts --output test.ts.qov --width 640 --height 480 --frames 150

# Should produce identical output to C# encoder for same input
```

### Priority 3: Complete Validation

**Steps after Priority 1 & 2:**
1. Run both encoders with identical test data
2. Perform bit-by-bit comparison of output files
3. Validate chunk structures match specification
4. Verify temporal encoding consistency

## 📝 Implementation Checklist

### C# Encoder Fixes
- [ ] Investigate and resolve header corruption
- [ ] Add debug logging to verify byte writes
- [ ] Consider alternative header writing approach
- [ ] Test with fresh rebuild from scratch
- [ ] Verify output matches specification

### TypeScript CLI Encoder  
- [ ] Create CLI interface for encoder
- [ ] Implement DVD logo pattern generation
- [ ] Add file output functionality
- [ ] Test CLI produces valid QOV files
- [ ] Verify compatibility with web player

### Validation Framework
- [ ] Run automated comparison tests
- [ ] Document any differences between implementations  
- [ ] Validate against QOV specification
- [ ] Create test regression suite
- [ ] Document compliance compliance

## 🎯 Success Criteria

### Phase 1: C# Encoder Fix
- [ ] Audio channels field = 0x00
- [ ] Reserved byte = 0x00
- [ ] File passes `analyze_qov.py` validation
- [ ] Chunks have correct sizes and structure

### Phase 2: TypeScript CLI
- [ ] CLI encoder produces valid QOV files
- [ ] CLI encoder accepts command-line arguments
- [ ] Output matches C# encoder for identical inputs

### Phase 3: Full Validation
- [ ] Both encoders produce identical outputs
- [ ] All validation tests pass
- [ ] Specification compliance verified
- [ ] Regression tests established

## 🔬 Testing Strategy

### Unit Tests
- Header field encoding correctness
- Chunk structure validation
- Compression/decompression consistency
- End marker verification

### Integration Tests
- Encode-decode round trip
- Cross-platform compatibility
- Multiple resolution/fps combinations
- Edge cases (single frame, maximum size)

### Comparison Tests
- Bit-by-bit file comparison
- Chunk-level validation
- Temporal consistency checks
- Quality metrics (PSNR, SSIM)

## 📅 Timeline

### Immediate (Priority 1)
- Investigate C# encoder corruption: 1-2 days
- Implement and verify fix: 1 day
- Validate fix produces correct output: 0.5 days

### Short-term (Priority 2)  
- TypeScript CLI encoder: 2-3 days
- Initial validation comparison: 1 day

### Medium-term (Priority 3)
- Complete validation framework: 2-3 days
- Documentation and test suite: 2 days

## 🚀 Getting Started

### Debug C# Encoder Corruption

```bash
# Step 1: Clean rebuild
cd /mnt/c/_mycode/qiv/csharp_qov
dotnet clean
rm -rf */bin */obj
dotnet build

# Step 2: Add debug logging to WriteHeader()
# Add Console.WriteLine before each _writer.Write() call

# Step 3: Run with logging
cd QovEncoder
dotnet run debug_test.qov

# Step 4: Analyze output
python3 /mnt/c/_mycode/qiv/qov-analysis-tools/analyze_qov.py debug_test.qov
```

### Create TypeScript CLI Encoder

```bash
# Create CLI interface
touch /mnt/c/_mycode/qiv/src/encoder-cli.ts
# Implement CLI logic

# Build CLI
npx tsc src/encoder-cli.ts

# Test CLI
node src/encoder-cli.js --output test.ts.qov
```

## 📊 Validation Metrics

### File Format Compliance
- Header field correctness: 100%
- Chunk structure validity: 100%
- End marker correctness: 100%

### Cross-Language Consistency  
- Bit-level match: 100% (target)
- Chunk-level match: 100% (target)
- Temporal consistency: 100% (target)

### Performance
- Encoding speed comparison
- File size equivalency
- Compression ratio consistency

## 🎓 Documentation Needs

- Encoder implementation guides (C# and TypeScript)
- Validation test documentation
- Specification compliance checklist
- Troubleshooting guides for common issues

## 🔗 Related Resources

- QOV Specification: `/mnt/c/_mycode/qiv/qov-specification.md`
- C# Encoder: `/mnt/c/_mycode/qiv/csharp_qov/QovLibrary/QovEncoder.cs`
- TypeScript Encoder: `/mnt/c/_mycode/qiv/src/qov-encoder.ts`
- Validation Tools: `/mnt/d/_mycode/qiv/qov-analysis-tools/`
- Test Programs: Both encoder directories

---

**Status:** In Progress - C# encoder corruption requires investigation
**Next Action:** Debug why compiled DLL doesn't match source code fixes
**Priority:** HIGH - Blocks complete encoder validation