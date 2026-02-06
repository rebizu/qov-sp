using Avalonia;
using Avalonia.Controls.ApplicationLifetimes;
using Avalonia.Data.Core;

using System.Linq;
using Avalonia.Markup.Xaml;
using QovGui.ViewModels;
using QovGui.Views;
using Microsoft.Extensions.DependencyInjection;
using QovGui.Services;
using System;

namespace QovGui;

public partial class App : Application
{
    public override void Initialize()
    {
        AvaloniaXamlLoader.Load(this);
    }

    public override void OnFrameworkInitializationCompleted()
    {
        if (ApplicationLifetime is IClassicDesktopStyleApplicationLifetime desktop)
        {
            // Dependency Injection Setup
            var collection = new ServiceCollection();
            collection.AddCommonServices();
            var services = collection.BuildServiceProvider();

            // Resolve MainViewModel
            var mainViewModel = services.GetRequiredService<MainWindowViewModel>();

            desktop.MainWindow = new MainWindow
            {
                DataContext = mainViewModel,
            };
        }

        base.OnFrameworkInitializationCompleted();
    }
}

public static class ServiceCollectionExtensions
{
    public static void AddCommonServices(this IServiceCollection collection)
    {
        collection.AddSingleton<IFFmpegService, FFmpegService>();
        collection.AddSingleton<IAudioService, AudioService>();
        collection.AddSingleton<IDialogService, DialogService>();
        
        // Register ViewModels
        collection.AddTransient<MainWindowViewModel>();
        collection.AddTransient<PlayerViewModel>();
        collection.AddTransient<RecorderViewModel>();
        collection.AddTransient<ConverterViewModel>();
    }
}