using System.Diagnostics;
using DownloadManager.Services;
using Microsoft.UI.Windowing;
using Microsoft.UI.Xaml;

namespace DownloadManager;

public partial class App : Application
{
    private Window? _window;

    public App()
    {
        InitializeComponent();
        UnhandledException += (_, e) =>
        {
            LogCrash(e.Exception);
            e.Handled = false;
        };
    }

    // Held for the life of the process: only one copy runs, so a second launch cannot start a second engine.
    private static Mutex? _singleInstance;

    protected override void OnLaunched(LaunchActivatedEventArgs args)
    {
        try
        {
            // A custom data folder (DM_DATA_DIR: tests, portable copies) is its own app and may run beside the real one.
            if (Environment.GetEnvironmentVariable("DM_DATA_DIR") is null)
            {
                _singleInstance = new Mutex(true, @"Local\HyperFetchPro.Main", out var first);
                if (!first)
                {
                    ShowRunningInstance();
                    Exit();
                    return;
                }
            }

            _window = new MainWindow();
            _window.Activate();
            // Started by Windows at sign-in (--minimized): stay in the taskbar so the browser hand-off works without a window in the way.
            if (Environment.GetCommandLineArgs().Contains("--minimized"))
                (_window.AppWindow.Presenter as OverlappedPresenter)?.Minimize();
        }
        catch (Exception ex)
        {
            LogCrash(ex);
            throw;
        }
    }

    /// <summary>Brings the window of the copy that is already running to the front (a launch from the Start menu while it is minimized).</summary>
    private static void ShowRunningInstance()
    {
        var other = Process.GetProcessesByName("DownloadManager").FirstOrDefault(p => p.Id != Environment.ProcessId && p.MainWindowHandle != IntPtr.Zero);
        if (other is null) return;
        if (NativeMethods.IsIconic(other.MainWindowHandle)) NativeMethods.ShowWindow(other.MainWindowHandle, 9); // SW_RESTORE
        NativeMethods.SetForegroundWindow(other.MainWindowHandle);
    }

    /// <summary>Writes unhandled exceptions to %LOCALAPPDATA%\DownloadManager\crash.log.</summary>
    private static void LogCrash(Exception ex)
    {
        try
        {
            var dir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "DownloadManager");
            Directory.CreateDirectory(dir);
            File.AppendAllText(Path.Combine(dir, "crash.log"), $"[{DateTime.Now:O}]\n{ex}\n\n");
        }
        catch { /* nothing else we can do */ }
    }
}
