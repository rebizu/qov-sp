namespace QovGuiNew;

/// <summary>
/// Output paths the user explicitly picked in a native file dialog.
/// WebSocket clients may only write to granted paths, so a web page cannot
/// use the local server to create or overwrite arbitrary files.
/// </summary>
public static class PathGrants
{
    private static readonly object Gate = new();
    private static readonly HashSet<string> Granted = new(StringComparer.OrdinalIgnoreCase);

    public static void Grant(string path)
    {
        lock (Gate)
        {
            Granted.Add(Path.GetFullPath(path));
        }
    }

    public static bool IsGranted(string path)
    {
        lock (Gate)
        {
            return Granted.Contains(Path.GetFullPath(path));
        }
    }
}
