using System.ComponentModel;
using System.Diagnostics;
using DownloadManager.Models;
using DownloadManager.Services;
using DownloadManager.ViewModels;
using Microsoft.UI.Dispatching;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Input;
using Microsoft.UI.Xaml.Media;
using Windows.ApplicationModel.DataTransfer;
using Windows.Foundation;

namespace DownloadManager;

public sealed partial class MainWindow : Window
{
    private readonly CoreClient _core = new();
    private readonly DispatcherQueue _ui = DispatcherQueue.GetForCurrentThread();
    private readonly DispatcherQueueTimer _limitTimer;
    private bool _suppressNav;
    private bool _suppressLimit;
    private DownloadItem? _inspected;

    public MainViewModel Vm { get; }

    public MainWindow()
    {
        Vm = new MainViewModel(_core);
        InitializeComponent();

        var icon = Path.Combine(AppContext.BaseDirectory, "Assets", "app.ico");
        if (File.Exists(icon)) AppWindow.SetIcon(icon); // taskbar and Alt+Tab icon
        ExtendsContentIntoTitleBar = true;
        SetTitleBar(TitleBarGrid);
        AppWindow.Resize(new Windows.Graphics.SizeInt32(1320, 820));

        var search = new KeyboardAccelerator { Key = Windows.System.VirtualKey.K, Modifiers = Windows.System.VirtualKeyModifiers.Control };
        search.Invoked += (_, e) => { SearchBox.Focus(FocusState.Keyboard); e.Handled = true; };
        Root.KeyboardAccelerators.Add(search);

        // Ctrl+, (VirtualKey has no name for the comma key, so use its code, 188).
        var options = new KeyboardAccelerator { Key = (Windows.System.VirtualKey)188, Modifiers = Windows.System.VirtualKeyModifiers.Control };
        options.Invoked += (_, e) => { Options_Click(this, new RoutedEventArgs()); e.Handled = true; };
        Root.KeyboardAccelerators.Add(options);

        _limitTimer = _ui.CreateTimer();
        _limitTimer.Interval = TimeSpan.FromMilliseconds(400);
        _limitTimer.IsRepeating = false;
        _limitTimer.Tick += async (_, _) => await Run(() => Vm.SetSpeedLimitAsync(LimitSlider.Value));

        Vm.PropertyChanged += OnVmChanged;
        _core.EventReceived += (name, data) => _ui.TryEnqueue(() =>
        {
            Vm.OnEvent(name, data);
            if (name == "capture.added") Toast("Download taken over from your browser");
            // A queue set to "exit when finished" closes the app once it has nothing left to do.
            if (name == "queue.finished" && data.GetProperty("afterAction").GetString() == "exit") Close();
        });
        _core.Exited += reason => _ui.TryEnqueue(() => { Vm.MarkDisconnected(reason); UpdateEngineDot(); });
        Closed += (_, _) => _core.Dispose();

        var disk = _ui.CreateTimer();
        disk.Interval = TimeSpan.FromSeconds(10);
        disk.Tick += (_, _) => UpdateDisk();
        disk.Start();

        _ = StartAsync();
    }

    private async Task StartAsync()
    {
        try
        {
            _core.Start();
            await Vm.LoadAsync();
            _suppressLimit = true;
            LimitSlider.Value = Vm.SpeedLimitMb;
            _suppressLimit = false;
        }
        catch (Exception ex)
        {
            Vm.MarkDisconnected("Engine unavailable");
            Toast(ex.Message, error: true);
        }
        UpdateEngineDot();
        UpdateDisk();
        DrawSpeed();
    }

    // --- view-model reactions -----------------------------------------------------

    private void OnVmChanged(object? sender, PropertyChangedEventArgs e)
    {
        switch (e.PropertyName)
        {
            case nameof(MainViewModel.SpeedHistory): DrawSpeed(); break;
            case nameof(MainViewModel.Connected): UpdateEngineDot(); break;
            case nameof(MainViewModel.DefaultDir): UpdateDisk(); break;
        }
    }

    private void UpdateEngineDot() =>
        EngineDot.Fill = (Brush)Application.Current.Resources[Vm.Connected ? "EmeraldBrush" : "RoseBrush"];

    private void DrawSpeed()
    {
        var points = Vm.SpeedHistory.ToArray();
        if (points.Length < 2) { SpeedLine.Points.Clear(); SpeedFill.Points.Clear(); return; }
        var max = Math.Max(points.Max(), 1);
        double w = SpeedCanvas.Width, h = SpeedCanvas.Height, step = w / (MainViewModel.SpeedHistoryLength - 1);
        var offset = w - step * (points.Length - 1);
        var line = new PointCollection();
        var fill = new PointCollection { new Point(offset, h) };
        for (var i = 0; i < points.Length; i++)
        {
            var p = new Point(offset + i * step, h - 2 - points[i] / max * (h - 6));
            line.Add(p);
            fill.Add(p);
        }
        fill.Add(new Point(offset + (points.Length - 1) * step, h));
        SpeedLine.Points = line;
        SpeedFill.Points = fill;
    }

    private void UpdateDisk()
    {
        try
        {
            var dir = string.IsNullOrEmpty(Vm.DefaultDir) ? Environment.GetFolderPath(Environment.SpecialFolder.UserProfile) : Vm.DefaultDir;
            var drive = new DriveInfo(Path.GetPathRoot(Path.GetFullPath(dir))!);
            DriveName.Text = $"{drive.Name.TrimEnd('\\')} ({drive.VolumeLabel})".Replace(" ()", "");
            DriveFree.Text = Fmt.Bytes(drive.AvailableFreeSpace) + " free";
            DriveBar.Value = 100.0 * (drive.TotalSize - drive.AvailableFreeSpace) / drive.TotalSize;
            DriveFolder.Text = dir;
        }
        catch { /* drive not ready */ }
    }

    // --- toolbar --------------------------------------------------------------------

    private async void Add_Click(object sender, RoutedEventArgs e)
    {
        var dialog = new AddDownloadDialog(this, Content.XamlRoot, Vm);
        var result = await dialog.ShowAsync();
        if (result == ContentDialogResult.None) return;
        var startNow = result == ContentDialogResult.Primary;
        await Run(async () =>
        {
            if (dialog.SelectedPlaylist is { } playlist)
            {
                if (playlist.Entries.Count == 0) { Toast("Select at least one video.", error: true); return; }
                await Vm.AddPlaylistAsync(playlist.Entries, playlist.Format, startNow, dialog.Folder, dialog.Headers);
                Toast(startNow ? $"Started {playlist.Entries.Count} videos" : $"Added {playlist.Entries.Count} videos to the queue");
            }
            else if (dialog.SelectedMedia is { } media)
                await Vm.AddMediaAsync(dialog.Url, media.Info, media.Format, startNow, dialog.Folder, dialog.Headers);
            else
                await Vm.AddAsync(dialog.Url, startNow, dialog.CategoryId, dialog.Folder, dialog.Headers);
            Toast(startNow ? "Download started" : "Added to the queue");
        });
    }

    private async void Scheduler_Click(object sender, RoutedEventArgs e)
    {
        await new SchedulerDialog(Content.XamlRoot, Vm).ShowAsync();
    }

    private async void EditCategories_Click(object sender, RoutedEventArgs e)
    {
        await new CategoriesDialog(this, Content.XamlRoot, Vm).ShowAsync();
        await Run(Vm.RefreshCategoriesAsync); // pick up added, renamed and deleted categories
    }

    private async void Options_Click(object sender, RoutedEventArgs e)
    {
        var dialog = new SettingsDialog(this, Content.XamlRoot, Vm);
        if (await dialog.ShowAsync() != ContentDialogResult.Primary) return;
        await Run(async () =>
        {
            await Vm.SaveSettingsAsync(dialog.Folder, dialog.Connections, dialog.SpeedMb, dialog.QuotaMb, dialog.QuotaHours);
            _suppressLimit = true; // keep the sidebar slider in step without re-saving
            LimitSlider.Value = Math.Clamp(Vm.SpeedLimitMb, LimitSlider.Minimum, LimitSlider.Maximum);
            _suppressLimit = false;
            Toast("Settings saved");
        });
    }

    private async void ResumeAll_Click(object sender, RoutedEventArgs e) => await Run(Vm.ResumeAllAsync);
    private async void PauseAll_Click(object sender, RoutedEventArgs e) => await Run(Vm.PauseAllAsync);
    private async void StartQueue_Click(object sender, RoutedEventArgs e) => await Run(Vm.StartQueueAsync);
    private async void StopQueue_Click(object sender, RoutedEventArgs e) => await Run(Vm.StopQueueAsync);
    private async void Turbo_Click(object sender, RoutedEventArgs e) => await Run(() => Vm.SetTurboAsync(!Vm.TurboOn));
    private void Search_TextChanged(object sender, TextChangedEventArgs e) => Vm.SetSearch(SearchBox.Text);

    private void Limit_ValueChanged(object sender, Microsoft.UI.Xaml.Controls.Primitives.RangeBaseValueChangedEventArgs e)
    {
        // Also fires while the XAML loads (range coercion), before the timer exists.
        if (_suppressLimit || _limitTimer is null) return;
        _limitTimer.Stop();
        _limitTimer.Start(); // apply once the slider stops moving
    }

    // --- sidebar --------------------------------------------------------------------

    private void Nav_SelectionChanged(object sender, SelectionChangedEventArgs e)
    {
        // Fires during InitializeComponent (SelectedIndex="0") before the rest of the tree exists.
        if (_suppressNav || CategoryList is null || NavList.SelectedItem is not ListViewItem item) return;
        _suppressNav = true;
        CategoryList.SelectedItem = null;
        _suppressNav = false;
        Vm.SetFilter((string)item.Tag);
    }

    private void Category_SelectionChanged(object sender, SelectionChangedEventArgs e)
    {
        if (_suppressNav || CategoryList.SelectedItem is not CategoryEntry entry) return;
        _suppressNav = true;
        NavList.SelectedItem = null;
        _suppressNav = false;
        Vm.SetCategoryFilter(entry.Id);
    }

    // --- list and rows ----------------------------------------------------------------

    private static DownloadItem? ItemOf(object sender) => (sender as FrameworkElement)?.Tag as DownloadItem;

    private void Downloads_SelectionChanged(object sender, SelectionChangedEventArgs e)
    {
        if (Drawer.Visibility == Visibility.Visible && DownloadList.SelectedItem is DownloadItem item) ShowDrawer(item);
    }

    private void Downloads_DoubleTapped(object sender, DoubleTappedRoutedEventArgs e)
    {
        if (DownloadList.SelectedItem is not DownloadItem item) return;
        if (item.IsCompleted && File.Exists(item.FullPath))
            Process.Start(new ProcessStartInfo(item.FullPath) { UseShellExecute = true });
        else ShowDrawer(item);
    }

    private void RowMenu_Opening(object? sender, object e)
    {
        if (sender is not MenuFlyout flyout) return;
        var item = flyout.Items.OfType<MenuFlyoutItem>().Select(m => m.Tag).OfType<DownloadItem>().FirstOrDefault();
        if (item is null) return;
        var items = flyout.Items.OfType<MenuFlyoutItem>().ToList();
        items[0].Visibility = Ui.Vis(item.CanPause);
        items[1].Visibility = Ui.Vis(item.CanResume);
    }

    private async void Row_Pause(object sender, RoutedEventArgs e) { if (ItemOf(sender) is { } d) await Run(() => Vm.PauseAsync(d)); }
    private async void Row_Resume(object sender, RoutedEventArgs e) { if (ItemOf(sender) is { } d) await Run(() => Vm.ResumeAsync(d)); }
    private void Row_Inspect(object sender, RoutedEventArgs e) { if (ItemOf(sender) is { } d) ShowDrawer(d); }

    private void Row_Explorer(object sender, RoutedEventArgs e)
    {
        if (ItemOf(sender) is not { } d) return;
        try
        {
            if (File.Exists(d.FullPath)) Process.Start("explorer.exe", $"/select,\"{d.FullPath}\"");
            else if (Directory.Exists(d.Dir)) Process.Start("explorer.exe", $"\"{d.Dir}\"");
            else Toast("That folder does not exist yet.", error: true);
        }
        catch (Exception ex) { Toast(ex.Message, error: true); }
    }

    private void Row_CopyLink(object sender, RoutedEventArgs e)
    {
        if (ItemOf(sender) is not { } d) return;
        CopyText(d.Url);
        Toast("Link copied");
    }

    private void Row_CopyCurl(object sender, RoutedEventArgs e)
    {
        if (ItemOf(sender) is not { } d) return;
        CopyText($"curl -L -C - -o \"{d.Filename}\" \"{d.Url}\"");
        Toast("curl command copied");
    }

    private async void Row_Remove(object sender, RoutedEventArgs e)
    {
        if (ItemOf(sender) is { } d) await Run(() => Vm.RemoveAsync(d, deleteFiles: false));
    }

    private async void Row_RemoveFiles(object sender, RoutedEventArgs e)
    {
        if (ItemOf(sender) is not { } d) return;
        var confirm = new ContentDialog
        {
            XamlRoot = Content.XamlRoot,
            Title = "Delete files?",
            Content = $"This removes “{d.Filename}” from the list and deletes it (and any partial data) from disk.",
            PrimaryButtonText = "Delete",
            CloseButtonText = "Cancel",
            DefaultButton = ContentDialogButton.Close,
        };
        if (await confirm.ShowAsync() == ContentDialogResult.Primary) await Run(() => Vm.RemoveAsync(d, deleteFiles: true));
    }

    // --- details drawer ----------------------------------------------------------------

    private void ShowDrawer(DownloadItem item)
    {
        if (_inspected is not null) _inspected.PropertyChanged -= OnInspectedChanged;
        _inspected = item;
        item.PropertyChanged += OnInspectedChanged;
        Drawer.Visibility = Visibility.Visible;
        RefreshDrawer();
    }

    private void CloseDrawer_Click(object sender, RoutedEventArgs e)
    {
        if (_inspected is not null) _inspected.PropertyChanged -= OnInspectedChanged;
        _inspected = null;
        Drawer.Visibility = Visibility.Collapsed;
    }

    private void OnInspectedChanged(object? sender, PropertyChangedEventArgs e)
    {
        if (e.PropertyName is nameof(DownloadItem.Segments) or nameof(DownloadItem.Status) or nameof(DownloadItem.Error))
            RefreshDrawer();
    }

    private void RefreshDrawer()
    {
        if (_inspected is not { } d) return;
        DrawerTitle.Text = d.Filename;
        DrawerUrl.Text = d.Url;
        SegmentList.ItemsSource = d.Segments.Where(s => s.End is null || s.Start + s.Written < s.End).ToList();
        DrawerConnCount.Text = d.IsRunning ? $"{d.ActiveConnections} active" : d.StatusText;

        var info = new List<string> { $"Saved to: {d.FullPath}" };
        if (!string.IsNullOrEmpty(d.FinalUrl) && d.FinalUrl != d.Url) info.Add($"Redirected to: {d.FinalUrl}");
        if (!string.IsNullOrEmpty(d.Etag)) info.Add($"ETag: {d.Etag}");
        if (!string.IsNullOrEmpty(d.LastModified)) info.Add($"Last modified: {d.LastModified}");
        if (d.Attempts > 0) info.Add($"Failed attempts: {d.Attempts}");
        DrawerInfo.Text = string.Join("\n", info);
        DrawerError.Text = string.IsNullOrEmpty(d.Error) ? "" : "Error: " + d.Error;
    }

    // --- helpers ---------------------------------------------------------------------------

    private async Task Run(Func<Task> action)
    {
        try { await action(); }
        catch (Exception ex) { Toast(ex.Message, error: true); }
    }

    private static void CopyText(string text)
    {
        var package = new DataPackage();
        package.SetText(text);
        Clipboard.SetContent(package);
    }

    private async void Toast(string message, bool error = false)
    {
        var accent = (Brush)Application.Current.Resources[error ? "RoseBrush" : "CyanBrush"];
        var toast = new Border
        {
            Background = new SolidColorBrush(Windows.UI.Color.FromArgb(0xF2, 0x11, 0x14, 0x22)),
            BorderBrush = accent,
            BorderThickness = new Thickness(1),
            CornerRadius = new CornerRadius(10),
            Padding = new Thickness(14, 8, 14, 8),
            Child = new TextBlock { Text = message, FontSize = 12, MaxWidth = 420, TextWrapping = TextWrapping.Wrap },
        };
        ToastHost.Children.Add(toast);
        await Task.Delay(error ? 6000 : 3000);
        ToastHost.Children.Remove(toast);
    }
}
