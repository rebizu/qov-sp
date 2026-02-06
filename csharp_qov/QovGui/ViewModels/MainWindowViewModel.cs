using CommunityToolkit.Mvvm.ComponentModel;
using QovGui.Services;

namespace QovGui.ViewModels;

public partial class MainWindowViewModel : ViewModelBase
{
    private readonly IFFmpegService _ffmpegService;
    private readonly IAudioService _audioService;
    private readonly IDialogService _dialogService;

    public string Greeting { get; } = "Welcome to QovGui!";

    [ObservableProperty] private PlayerViewModel _playerViewModel;
    [ObservableProperty] private RecorderViewModel _recorderViewModel;
    [ObservableProperty] private ConverterViewModel _converterViewModel;

    public MainWindowViewModel(IFFmpegService ffmpegService, IAudioService audioService, IDialogService dialogService, PlayerViewModel playerViewModel, RecorderViewModel recorderViewModel, ConverterViewModel converterViewModel)
    {
        _ffmpegService = ffmpegService;
        _audioService = audioService;
        _dialogService = dialogService;
        _playerViewModel = playerViewModel;
        _recorderViewModel = recorderViewModel;
        _converterViewModel = converterViewModel;
    }
    
    // Default constructor for design-time preview
    public MainWindowViewModel() 
    {
         _ffmpegService = null!;
         _audioService = null!;
         _dialogService = null!;
         _playerViewModel = new PlayerViewModel();
         _recorderViewModel = new RecorderViewModel();
         _converterViewModel = new ConverterViewModel();
    }
}
