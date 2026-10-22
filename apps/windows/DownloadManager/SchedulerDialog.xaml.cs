using DownloadManager.Models;
using DownloadManager.ViewModels;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;

namespace DownloadManager;

public sealed partial class SchedulerDialog : ContentDialog
{
    private readonly MainViewModel _vm;
    private readonly CheckBox[] _days;
    private List<QueueDto> _queues = [];
    private bool _loading;
    private int? _selectedId;

    public SchedulerDialog(XamlRoot root, MainViewModel vm)
    {
        _vm = vm;
        InitializeComponent();
        XamlRoot = root;
        _days = [DaySun, DayMon, DayTue, DayWed, DayThu, DayFri, DaySat];
        Loaded += async (_, _) => await ReloadAsync(null);
    }

    private QueueDto? Selected => QueueList.SelectedItem as QueueDto;

    private async Task ReloadAsync(int? select)
    {
        try
        {
            _queues = await _vm.ListQueuesAsync();
        }
        catch (Exception ex)
        {
            Say(ex.Message, error: true);
            return;
        }
        _loading = true;
        QueueList.ItemsSource = _queues;
        var wanted = select ?? _selectedId;
        QueueList.SelectedItem = _queues.FirstOrDefault(q => q.Id == wanted) ?? _queues.FirstOrDefault();
        _loading = false;
        Populate();
    }

    private void Queue_SelectionChanged(object sender, SelectionChangedEventArgs e)
    {
        // Also fires while the dialog is being built, before the editor exists.
        if (_loading || Editor is null) return;
        Populate();
    }

    private void Populate()
    {
        var q = Selected;
        Editor.Visibility = q is null ? Visibility.Collapsed : Visibility.Visible;
        DeleteButton.IsEnabled = q is { Id: > 2 };
        if (q is null) return;
        _selectedId = q.Id;

        NameBox.Text = q.Name;
        ParBox.Value = q.MaxParallel;
        KindText.Text = q.Kind == "sync"
            ? "Synchronization queue: files stay in the queue and are re-downloaded only when they changed on the server."
            : "Download queue: files leave the queue when finished.";
        SyncHint.Text = q.Kind == "sync" ? "Checking runs once at the start time (repeat intervals are planned)." : "";

        StartCheck.IsChecked = q.StartTime is not null;
        StartPicker.Time = ParseTime(q.StartTime) ?? new TimeSpan(2, 0, 0);
        StopCheck.IsChecked = q.StopTime is not null;
        StopPicker.Time = ParseTime(q.StopTime) ?? new TimeSpan(6, 0, 0);
        for (var i = 0; i < 7; i++) _days[i].IsChecked = (q.Days & (1 << i)) != 0;
        AfterBox.SelectedIndex = q.AfterAction == "exit" ? 1 : 0;

        StartNowButton.IsEnabled = !q.Running;
        StopNowButton.IsEnabled = q.Running;
        Say("", error: false);
    }

    private static TimeSpan? ParseTime(string? hhmm) =>
        hhmm is not null && TimeSpan.TryParseExact(hhmm, "hh\\:mm", null, out var t) ? t : null;

    private static string Format(TimeSpan t) => $"{t.Hours:00}:{t.Minutes:00}";

    private void Say(string text, bool error)
    {
        Status.Text = text;
        Status.Foreground = (Microsoft.UI.Xaml.Media.Brush)Application.Current.Resources[error ? "RoseBrush" : "EmeraldBrush"];
    }

    // --- actions ---------------------------------------------------------------------

    private async void Apply_Click(object sender, RoutedEventArgs e)
    {
        if (Selected is not { } q) return;
        var name = NameBox.Text.Trim();
        if (name.Length == 0) { Say("Give the queue a name.", error: true); return; }
        var days = 0;
        for (var i = 0; i < 7; i++) if (_days[i].IsChecked == true) days |= 1 << i;
        if (days == 0 && (StartCheck.IsChecked == true || StopCheck.IsChecked == true))
        {
            Say("Choose at least one day for the schedule.", error: true);
            return;
        }
        try
        {
            await _vm.UpdateQueueAsync(new
            {
                id = q.Id,
                name,
                maxParallel = (int)Math.Clamp(double.IsNaN(ParBox.Value) ? 1 : ParBox.Value, 1, 10),
                startTime = StartCheck.IsChecked == true ? Format(StartPicker.Time) : null,
                stopTime = StopCheck.IsChecked == true ? Format(StopPicker.Time) : null,
                days = days == 0 ? 127 : days,
                afterAction = AfterBox.SelectedIndex == 1 ? "exit" : "none",
            });
            await ReloadAsync(q.Id);
            Say("Saved.", error: false);
        }
        catch (Exception ex) { Say(ex.Message, error: true); }
    }

    private void NewDownloadQueue_Click(object sender, RoutedEventArgs e) => _ = NewQueueAsync("download");
    private void NewSyncQueue_Click(object sender, RoutedEventArgs e) => _ = NewQueueAsync("sync");

    private async Task NewQueueAsync(string kind)
    {
        try
        {
            var q = await _vm.AddQueueAsync(kind == "sync" ? "New sync queue" : "New queue", kind);
            await ReloadAsync(q.Id);
            NameBox.Focus(FocusState.Programmatic);
            NameBox.SelectAll();
        }
        catch (Exception ex) { Say(ex.Message, error: true); }
    }

    private async void Delete_Click(object sender, RoutedEventArgs e)
    {
        if (Selected is not { Id: > 2 } q) return;
        try
        {
            await _vm.DeleteQueueAsync(q.Id); // its downloads stay in the list, just unqueued
            _selectedId = null;
            await ReloadAsync(null);
            Say($"Deleted “{q.Name}”. Its downloads were kept.", error: false);
        }
        catch (Exception ex) { Say(ex.Message, error: true); }
    }

    private async void StartNow_Click(object sender, RoutedEventArgs e)
    {
        if (Selected is not { } q) return;
        try { await _vm.StartQueueAsync(q.Id); await ReloadAsync(q.Id); Say("Queue started.", error: false); }
        catch (Exception ex) { Say(ex.Message, error: true); }
    }

    private async void StopNow_Click(object sender, RoutedEventArgs e)
    {
        if (Selected is not { } q) return;
        try { await _vm.StopQueueAsync(q.Id); await ReloadAsync(q.Id); Say("Queue stopped.", error: false); }
        catch (Exception ex) { Say(ex.Message, error: true); }
    }
}
