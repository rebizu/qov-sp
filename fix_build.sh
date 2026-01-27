#!/bin/bash
cd /mnt/c/_mycode/qiv/csharp_qov

# Fix ScreenRecorder project file
sed -i '/SkiaSharp/!a <PackageReference Include="SkiaSharp" Version="2.88.6" />' QovScreenRecorder/QovScreenRecorder.csproj

# Fix Encoder namespace collision
sed -i 's/QovEncoder encoder = new/QovLibrary.QovEncoder encoder = new/g' QovEncoder/Program.cs

# Remove SkiaSharp dependency from Player (not needed)
sed -i '/SkiaSharp/d' QovPlayer/QovPlayer.csproj

# Remove System.CommandLine from Player (not needed)
sed -i '/System.CommandLine/d' QovPlayer/QovPlayer.csproj

# Remove using System.CommandLine from Player
sed -i '/CommandLine/d' QovPlayer/Program.cs

# Build
dotnet build