using System.Net;
using System.Net.WebSockets;

namespace QovGuiNew;

public class WebSocketServer
{
    private readonly HttpListener _listener;
    private readonly string _url;
    public RecorderService RecorderService { get; } = new RecorderService();
    public PlayerService PlayerService { get; } = new PlayerService();
    public ConverterService ConverterService { get; } = new ConverterService();

    public WebSocketServer(string url)
    {
        _url = url;
        _listener = new HttpListener();
        _listener.Prefixes.Add(url);
    }

    /// <summary>
    /// Binds the port synchronously and spawns the accept loop.
    /// Returns null on success, or the error message if binding failed.
    /// </summary>
    public string? TryStart()
    {
        try
        {
            _listener.Start();
        }
        catch (Exception ex)
        {
            return ex.Message;
        }

        Console.WriteLine($"Listening on {_url}");
        _ = AcceptLoopAsync();
        return null;
    }

    public void Stop()
    {
        _listener.Stop();
    }

    private async Task AcceptLoopAsync()
    {
        while (_listener.IsListening)
        {
            try
            {
                var context = await _listener.GetContextAsync();
                // Handle each connection concurrently; awaiting the connection
                // lifetime here would block every other client until the first
                // socket disconnects
                _ = HandleContextAsync(context);
            }
            catch (Exception ex)
            {
                if (_listener.IsListening)
                {
                    Console.WriteLine("Server Error: " + ex.Message);
                }
            }
        }
    }

    private async Task HandleContextAsync(HttpListenerContext context)
    {
        try
        {
            if (context.Request.IsWebSocketRequest)
            {
                if (!IsOriginAllowed(context.Request.Headers["Origin"]))
                {
                    Console.WriteLine($"Rejected WebSocket request from origin: {context.Request.Headers["Origin"]}");
                    context.Response.StatusCode = 403;
                    context.Response.Close();
                    return;
                }
                await ProcessWebSocketRequest(context);
            }
            else
            {
                context.Response.StatusCode = 400;
                context.Response.Close();
            }
        }
        catch (Exception ex)
        {
            Console.WriteLine("Server Error: " + ex.Message);
            try { context.Response.Close(); } catch { /* already gone */ }
        }
    }

    // Remote web pages must not reach the local services. Local origins
    // (the app's file:// UI, missing host) are allowed; arbitrary local
    // pages are still contained by the PathGrants output-path check.
    private static bool IsOriginAllowed(string? origin)
    {
        if (string.IsNullOrEmpty(origin) || origin == "null") return true;
        if (origin.StartsWith("file://", StringComparison.OrdinalIgnoreCase)) return true;
        if (Uri.TryCreate(origin, UriKind.Absolute, out var uri))
        {
            return uri.Host == "localhost" || uri.Host == "127.0.0.1" || uri.Host == "::1";
        }
        return false;
    }

    private async Task ProcessWebSocketRequest(HttpListenerContext context)
    {
        var wsContext = await context.AcceptWebSocketAsync(null);
        var ws = wsContext.WebSocket;
        var path = context.Request.Url?.AbsolutePath;

        Console.WriteLine($"WebSocket connected: {path}");

        try
        {
            if (path == "/record")
            {
                await RecorderService.HandleConnection(ws);
            }
            else if (path == "/play")
            {
                await PlayerService.HandleConnection(ws);
            }
            else if (path == "/convert")
            {
                await ConverterService.HandleConnection(ws);
            }
            else
            {
                await ws.CloseAsync(WebSocketCloseStatus.PolicyViolation, "Unknown path", CancellationToken.None);
            }
        }
        catch (Exception ex)
        {
            Console.WriteLine($"Socket Error ({path}): {ex.Message}");
        }
        finally
        {
            if (ws.State == WebSocketState.Open)
                await ws.CloseAsync(WebSocketCloseStatus.NormalClosure, "Done", CancellationToken.None);

            ws.Dispose();
        }
    }
}
