using System.Threading.Tasks;

namespace QovGui.Services;

public interface IDialogService
{
    Task<string?> ShowOpenFileDialogAsync(string title, string[] extensions);
    Task<string?> ShowSaveFileDialogAsync(string title, string defaultExtension, string defaultName);
    Task ShowAlertAsync(string title, string message);
}
