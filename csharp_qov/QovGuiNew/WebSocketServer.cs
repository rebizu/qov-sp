using System.Net;
using System.Net.WebSockets;
using System.Text;

namespace QovGuiNew;

public class WebSocketServer
{
    private HttpListener _listener;
    private string _url;
    public RecorderService RecorderService { get; } = new RecorderService();
    public PlayerService PlayerService { get; } = new PlayerService();
    public ConverterService ConverterService { get; } = new ConverterService();

    public WebSocketServer(string url)
    {
        _url = url;
        _listener = new HttpListener();
        _listener.Prefixes.Add(url);
    }

    public async Task Start()
    {
        _listener.Start();
        Console.WriteLine($"Listening on {_url}");

        while (_listener.IsListening)
        {
            try
            {
                var context = await _listener.GetContextAsync();
                if (context.Request.IsWebSocketRequest)
                {
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
            }
        }
    }

    public void Stop()
    {
        _listener.Stop();
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
