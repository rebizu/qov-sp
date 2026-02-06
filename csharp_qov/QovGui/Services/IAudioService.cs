using System.IO;
using System.Threading.Tasks;

namespace QovGui.Services;

public interface IAudioService
{
    Task PlayAudioAsync(Stream audioStream);
    Task StopAsync();
}
