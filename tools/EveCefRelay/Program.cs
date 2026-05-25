using System.Collections.Concurrent;
using System.Diagnostics;
using System.Drawing;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using CefSharp;
using CefSharp.OffScreen;
using SixLabors.ImageSharp;
using SixLabors.ImageSharp.Formats.Jpeg;
using SixLabors.ImageSharp.PixelFormats;

var config = RelayConfig.Parse(args);
Directory.CreateDirectory(config.CachePath);

CefSharpSettings.SubprocessExitIfParentProcessClosed = true;
Cef.Initialize(new CefSettings
{
    WindowlessRenderingEnabled = true,
    CachePath = config.CachePath,
    LogSeverity = LogSeverity.Warning,
});

using var renderer = new CefDashboardRenderer(config);
await renderer.StartAsync();

using var server = new EveRelayServer(config, renderer);
await server.RunAsync();

Cef.Shutdown();

internal sealed class CefDashboardRenderer : IDisposable
{
    private readonly RelayConfig config;
    private readonly ConcurrentDictionary<Guid, EveClient> clients = new();
    private readonly Stopwatch frameClock = Stopwatch.StartNew();
    private ChromiumWebBrowser? browser;
    private byte[]? latestFrame;
    private long lastSentMs;

    public CefDashboardRenderer(RelayConfig config)
    {
        this.config = config;
    }

    public IReadOnlyDictionary<Guid, EveClient> Clients => clients;

    public byte[]? LatestFrame => latestFrame;

    public async Task StartAsync()
    {
        browser = new ChromiumWebBrowser(config.Url)
        {
            Size = new System.Drawing.Size(config.Width, config.Height),
            DeviceScaleFactor = config.DeviceScaleFactor,
        };
        browser.Paint += OnPaint;
        await browser.WaitForInitialLoadAsync();
        Console.WriteLine($"CEF loaded: {config.Url}");
        Console.WriteLine($"Viewport: {config.Width}x{config.Height} scale {config.DeviceScaleFactor:0.##}");
    }

    public void AddClient(Guid id, EveClient client)
    {
        clients[id] = client;
    }

    public void RemoveClient(Guid id)
    {
        clients.TryRemove(id, out _);
    }

    public void DispatchPointer(PointerMessage message)
    {
        var host = browser?.GetBrowser()?.GetHost();
        if (host == null)
        {
            return;
        }

        var x = Math.Clamp((int)Math.Round(message.X), 0, config.Width - 1);
        var y = Math.Clamp((int)Math.Round(message.Y), 0, config.Height - 1);
        var mouse = new MouseEvent(x, y, CefEventFlags.None);

        switch (message.Phase)
        {
            case "down":
                host.SendMouseMoveEvent(mouse, mouseLeave: false);
                host.SendMouseClickEvent(mouse, MouseButtonType.Left, mouseUp: false, clickCount: 1);
                break;
            case "up":
                host.SendMouseClickEvent(mouse, MouseButtonType.Left, mouseUp: true, clickCount: 1);
                break;
            default:
                host.SendMouseMoveEvent(mouse, mouseLeave: false);
                break;
        }
    }

    private void OnPaint(object? sender, OnPaintEventArgs e)
    {
        if (e.IsPopup)
        {
            return;
        }

        var nowMs = frameClock.ElapsedMilliseconds;
        if (nowMs - Interlocked.Read(ref lastSentMs) < config.FrameIntervalMs)
        {
            return;
        }
        Interlocked.Exchange(ref lastSentMs, nowMs);

        var jpeg = EncodeJpeg(e.BufferHandle, e.Width, e.Height, config.JpegQuality);
        latestFrame = jpeg;
        _ = BroadcastFrameAsync(jpeg);
    }

    private async Task BroadcastFrameAsync(byte[] frame)
    {
        foreach (var (id, socket) in clients)
        {
            try
            {
                await socket.SendBinaryAsync(frame);
            }
            catch
            {
                RemoveClient(id);
            }
        }
    }

    private static byte[] EncodeJpeg(IntPtr bgraBuffer, int width, int height, long quality)
    {
        var pixels = new byte[width * height * 4];
        Marshal.Copy(bgraBuffer, pixels, 0, pixels.Length);
        using var image = Image.LoadPixelData<Bgra32>(pixels, width, height);
        using var stream = new MemoryStream();
        image.SaveAsJpeg(stream, new JpegEncoder { Quality = (int)quality });
        return stream.ToArray();
    }

    public void Dispose()
    {
        browser?.Dispose();
    }
}

internal sealed class EveRelayServer : IDisposable
{
    private readonly RelayConfig config;
    private readonly CefDashboardRenderer renderer;
    private readonly TcpListener listener;

    public EveRelayServer(RelayConfig config, CefDashboardRenderer renderer)
    {
        this.config = config;
        this.renderer = renderer;
        listener = new TcpListener(IPAddress.Any, config.Port);
    }

    public async Task RunAsync()
    {
        listener.Start();
        Console.WriteLine($"Eve CEF relay listening: http://{config.LanHost}:{config.Port}/stream");
        Console.WriteLine("Stop with Ctrl+C.");

        while (true)
        {
            var client = await listener.AcceptTcpClientAsync();
            _ = Task.Run(() => HandleAsync(client));
        }
    }

    private async Task HandleAsync(TcpClient tcpClient)
    {
        await using var stream = tcpClient.GetStream();
        var request = await ReadHttpRequestAsync(stream);
        if (request.Path == "/health")
        {
            var health = JsonSerializer.Serialize(new
            {
                ok = true,
                config.Width,
                config.Height,
                config.DeviceScaleFactor,
                clients = renderer.Clients.Count,
                hasFrame = renderer.LatestFrame != null,
                config.Url,
            });
            await WriteHttpResponseAsync(stream, "200 OK", "application/json", Encoding.UTF8.GetBytes(health));
            return;
        }

        if (request.Path != "/stream" || !request.Headers.TryGetValue("Sec-WebSocket-Key", out var key))
        {
            await WriteHttpResponseAsync(stream, "404 Not Found", "text/plain", Encoding.UTF8.GetBytes("not found"));
            return;
        }

        await WriteWebSocketHandshakeAsync(stream, key);
        var id = Guid.NewGuid();
        using var client = new EveClient(tcpClient, stream);
        renderer.AddClient(id, client);

        await client.SendTextAsync(JsonSerializer.Serialize(new
        {
            type = "config",
            config.Width,
            config.Height,
            config.DeviceScaleFactor,
        }));

        if (renderer.LatestFrame is { } frame)
        {
            await client.SendBinaryAsync(frame);
        }

        await ReceiveLoopAsync(id, client);
    }

    private async Task ReceiveLoopAsync(Guid id, EveClient client)
    {
        try
        {
            while (true)
            {
                var message = await client.ReceiveAsync();
                if (message.Opcode == 0x8)
                {
                    break;
                }
                if (message.Opcode != 0x1)
                {
                    continue;
                }

                var json = Encoding.UTF8.GetString(message.Payload);
                var pointer = JsonSerializer.Deserialize<PointerMessage>(json);
                if (pointer?.Type == "pointer")
                {
                    renderer.DispatchPointer(pointer);
                }
            }
        }
        finally
        {
            renderer.RemoveClient(id);
        }
    }

    private static async Task<HttpRequest> ReadHttpRequestAsync(NetworkStream stream)
    {
        var bytes = new List<byte>();
        var lastFour = new Queue<byte>(4);
        while (true)
        {
            var value = stream.ReadByte();
            if (value < 0)
            {
                throw new IOException("Client closed before HTTP headers completed.");
            }
            var b = (byte)value;
            bytes.Add(b);
            lastFour.Enqueue(b);
            if (lastFour.Count > 4)
            {
                lastFour.Dequeue();
            }
            if (lastFour.Count == 4 && lastFour.SequenceEqual(new byte[] { 13, 10, 13, 10 }))
            {
                break;
            }
        }

        var text = Encoding.ASCII.GetString(bytes.ToArray());
        var lines = text.Split("\r\n", StringSplitOptions.None);
        var first = lines[0].Split(' ');
        var headers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var line in lines.Skip(1))
        {
            var colon = line.IndexOf(':');
            if (colon > 0)
            {
                headers[line[..colon].Trim()] = line[(colon + 1)..].Trim();
            }
        }
        await Task.CompletedTask;
        return new HttpRequest(first.Length > 1 ? first[1] : "/", headers);
    }

    private static async Task WriteHttpResponseAsync(NetworkStream stream, string status, string contentType, byte[] body)
    {
        var header = Encoding.ASCII.GetBytes(
            $"HTTP/1.1 {status}\r\nContent-Type: {contentType}\r\nContent-Length: {body.Length}\r\nConnection: close\r\n\r\n");
        await stream.WriteAsync(header);
        await stream.WriteAsync(body);
    }

    private static async Task WriteWebSocketHandshakeAsync(NetworkStream stream, string key)
    {
        var acceptBytes = SHA1.HashData(Encoding.ASCII.GetBytes(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"));
        var accept = Convert.ToBase64String(acceptBytes);
        var response = Encoding.ASCII.GetBytes(
            "HTTP/1.1 101 Switching Protocols\r\n" +
            "Upgrade: websocket\r\n" +
            "Connection: Upgrade\r\n" +
            $"Sec-WebSocket-Accept: {accept}\r\n\r\n");
        await stream.WriteAsync(response);
    }

    public void Dispose()
    {
        listener.Stop();
    }
}

internal sealed class EveClient : IDisposable
{
    private readonly TcpClient tcpClient;
    private readonly NetworkStream stream;
    private readonly SemaphoreSlim sendLock = new(1, 1);

    public EveClient(TcpClient tcpClient, NetworkStream stream)
    {
        this.tcpClient = tcpClient;
        this.stream = stream;
    }

    public Task SendTextAsync(string text)
    {
        return SendFrameAsync(0x1, Encoding.UTF8.GetBytes(text));
    }

    public Task SendBinaryAsync(byte[] payload)
    {
        return SendFrameAsync(0x2, payload);
    }

    private async Task SendFrameAsync(byte opcode, byte[] payload)
    {
        await sendLock.WaitAsync();
        try
        {
            var header = new List<byte> { (byte)(0x80 | opcode) };
            if (payload.Length <= 125)
            {
                header.Add((byte)payload.Length);
            }
            else if (payload.Length <= ushort.MaxValue)
            {
                header.Add(126);
                header.Add((byte)(payload.Length >> 8));
                header.Add((byte)(payload.Length & 0xff));
            }
            else
            {
                header.Add(127);
                var length = (ulong)payload.Length;
                for (var shift = 56; shift >= 0; shift -= 8)
                {
                    header.Add((byte)(length >> shift));
                }
            }

            await stream.WriteAsync(header.ToArray());
            await stream.WriteAsync(payload);
        }
        finally
        {
            sendLock.Release();
        }
    }

    public async Task<WebSocketFrame> ReceiveAsync()
    {
        var first = await ReadExactlyAsync(2);
        var opcode = (byte)(first[0] & 0x0f);
        var masked = (first[1] & 0x80) != 0;
        ulong length = (ulong)(first[1] & 0x7f);
        if (length == 126)
        {
            var extended = await ReadExactlyAsync(2);
            length = (ulong)((extended[0] << 8) | extended[1]);
        }
        else if (length == 127)
        {
            var extended = await ReadExactlyAsync(8);
            length = 0;
            foreach (var b in extended)
            {
                length = (length << 8) | b;
            }
        }

        var mask = masked ? await ReadExactlyAsync(4) : Array.Empty<byte>();
        var payload = await ReadExactlyAsync((int)length);
        if (masked)
        {
            for (var i = 0; i < payload.Length; i++)
            {
                payload[i] = (byte)(payload[i] ^ mask[i % 4]);
            }
        }
        return new WebSocketFrame(opcode, payload);
    }

    private async Task<byte[]> ReadExactlyAsync(int length)
    {
        var buffer = new byte[length];
        var offset = 0;
        while (offset < length)
        {
            var read = await stream.ReadAsync(buffer.AsMemory(offset, length - offset));
            if (read == 0)
            {
                throw new IOException("WebSocket closed.");
            }
            offset += read;
        }
        return buffer;
    }

    public void Dispose()
    {
        sendLock.Dispose();
        tcpClient.Dispose();
    }
}

internal sealed record HttpRequest(string Path, Dictionary<string, string> Headers);

internal sealed record WebSocketFrame(byte Opcode, byte[] Payload);

internal sealed record PointerMessage(
    string Type,
    string Phase,
    double X,
    double Y
);

internal sealed record RelayConfig(
    string Url,
    string ListenHost,
    string LanHost,
    int Port,
    int Width,
    int Height,
    float DeviceScaleFactor,
    long JpegQuality,
    int Fps,
    string CachePath
)
{
    public int FrameIntervalMs => Math.Max(1, 1000 / Math.Max(1, Fps));

    public static RelayConfig Parse(string[] args)
    {
        var values = new Dictionary<string, string?>(StringComparer.OrdinalIgnoreCase);
        for (var i = 0; i < args.Length; i++)
        {
            if (!args[i].StartsWith("--"))
            {
                continue;
            }

            var key = args[i][2..];
            var next = i + 1 < args.Length && !args[i + 1].StartsWith("--") ? args[++i] : "true";
            values[key] = next;
        }

        var repoRoot = FindRepoRoot();
        var dashboard = Path.Combine(repoRoot, ".voidbot", "status", "swarm-dashboard.html");
        var url = values.GetValueOrDefault("url") ?? new Uri(dashboard).AbsoluteUri;
        return new RelayConfig(
            Url: url,
            ListenHost: values.GetValueOrDefault("host") ?? "*",
            LanHost: values.GetValueOrDefault("lanHost") ?? "192.168.1.66",
            Port: IntValue(values, "port", 8792),
            Width: IntValue(values, "width", 1620),
            Height: IntValue(values, "height", 2160),
            DeviceScaleFactor: FloatValue(values, "scale", 2.0f),
            JpegQuality: IntValue(values, "quality", 74),
            Fps: IntValue(values, "fps", 20),
            CachePath: values.GetValueOrDefault("cachePath") ?? Path.Combine(repoRoot, ".voidbot", "cef-cache")
        );
    }

    private static string FindRepoRoot()
    {
        var dir = AppContext.BaseDirectory;
        while (dir != null && !File.Exists(Path.Combine(dir, "package.json")))
        {
            dir = Directory.GetParent(dir)?.FullName;
        }
        return dir ?? Directory.GetCurrentDirectory();
    }

    private static int IntValue(Dictionary<string, string?> values, string key, int fallback)
    {
        return values.TryGetValue(key, out var value) && int.TryParse(value, out var parsed) ? parsed : fallback;
    }

    private static float FloatValue(Dictionary<string, string?> values, string key, float fallback)
    {
        return values.TryGetValue(key, out var value) && float.TryParse(value, out var parsed) ? parsed : fallback;
    }
}
