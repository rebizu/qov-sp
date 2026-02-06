using System.IO;
using System.Threading.Tasks;

namespace QovGui.Services;

public class AudioService : IAudioService
{
    public Task PlayAudioAsync(Stream audioStream)
    {
        // TODO: Implement audio playback
        return Task.CompletedTask;
    }

    public Task StopAsync()
    {
        // TODO: Stop playback
        return Task.CompletedTask;
    }
}
