using System.Threading.Tasks;
using Avalonia;
using Avalonia.Controls.ApplicationLifetimes;
using Avalonia.Platform.Storage;
using System.Linq;

namespace QovGui.Services;

public class DialogService : IDialogService
{
    public async Task<string?> ShowOpenFileDialogAsync(string title, string[] extensions)
    {
        if (Application.Current?.ApplicationLifetime is IClassicDesktopStyleApplicationLifetime desktop)
        {
            var topLevel = Avalonia.Controls.TopLevel.GetTopLevel(desktop.MainWindow);
            if (topLevel == null) return null;

            var files = await topLevel.StorageProvider.OpenFilePickerAsync(new FilePickerOpenOptions
            {
                Title = title,
                AllowMultiple = false,
                FileTypeFilter = extensions.Select(ext => new FilePickerFileType(ext) { Patterns = new[] { $"*.{ext}" } }).ToList()
            });

            return files.FirstOrDefault()?.Path.LocalPath;
        }
        return null;
    }

    public async Task<string?> ShowSaveFileDialogAsync(string title, string defaultExtension, string defaultName)
    {
        if (Application.Current?.ApplicationLifetime is IClassicDesktopStyleApplicationLifetime desktop)
        {
            var topLevel = Avalonia.Controls.TopLevel.GetTopLevel(desktop.MainWindow);
            if (topLevel == null) return null;

            var file = await topLevel.StorageProvider.SaveFilePickerAsync(new FilePickerSaveOptions
            {
                Title = title,
                DefaultExtension = defaultExtension,
                SuggestedFileName = defaultName,
                FileTypeChoices = new[] { new FilePickerFileType(defaultExtension) { Patterns = new[] { $"*.{defaultExtension}" } } }
            });

            return file?.Path.LocalPath;
        }
        return null;
    }

    public Task ShowAlertAsync(string title, string message)
    {
        // Simple MessageBox implementation or custom dialog
        // For now, just logging or simple check
        // Implement appropriate dialog logic here
        return Task.CompletedTask;
    }
}
