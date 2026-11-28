// Minimal console host for PoB's own LuaJIT (lua51.dll from PoB's Windows runtime).
// Stands in for luajit.exe so the bundled PoB can run headless on Windows without a download.
// Built with the .NET Framework compiler that ships with Windows (see build.ps1).
//
// Usage: luahost.exe <runtimeDir> <workDir> <script.lua> [args...]
//   runtimeDir  folder holding lua51.dll and PoB's C modules (lua-utf8.dll etc.)
//   workDir     working directory for the script (PoB's src folder)
//   script.lua  run with `arg` set like luajit does: arg[0] = script, arg[1..] = args
// LUA_PATH / LUA_CPATH are read from the environment by luaL_openlibs, as with luajit.exe.
//
// Native Inflate (V22): PoB's headless _SimpleGraphic.def.lua stubs Inflate to return "", which leaves
// timeless-jewel lookup tables empty, silently. The host provides a real zlib/gzip Inflate and pins it
// with a metatable on _G, so the stub's later assignment is ignored and scripts that call
// dofile("HeadlessWrapper.lua") need no change.
using System;
using System.IO;
using System.IO.Compression;
using System.Runtime.InteropServices;
using System.Text;

internal static class LuaHost
{
    private const string Lua = "lua51.dll";
    private const int LuaGlobalsIndex = -10002;

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool SetDllDirectory(string path);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr LoadLibrary(string path);

    [DllImport(Lua, CallingConvention = CallingConvention.Cdecl)]
    private static extern IntPtr luaL_newstate();

    [DllImport(Lua, CallingConvention = CallingConvention.Cdecl)]
    private static extern void luaL_openlibs(IntPtr state);

    [DllImport(Lua, CallingConvention = CallingConvention.Cdecl)]
    private static extern int luaL_loadbuffer(IntPtr state, byte[] buffer, UIntPtr size, string name);

    [DllImport(Lua, CallingConvention = CallingConvention.Cdecl)]
    private static extern int lua_pcall(IntPtr state, int nargs, int nresults, int errfunc);

    [DllImport(Lua, CallingConvention = CallingConvention.Cdecl)]
    private static extern IntPtr lua_tolstring(IntPtr state, int index, out UIntPtr length);

    [DllImport(Lua, CallingConvention = CallingConvention.Cdecl)]
    private static extern void lua_createtable(IntPtr state, int narr, int nrec);

    [DllImport(Lua, CallingConvention = CallingConvention.Cdecl)]
    private static extern void lua_pushlstring(IntPtr state, byte[] text, UIntPtr length);

    [DllImport(Lua, CallingConvention = CallingConvention.Cdecl)]
    private static extern void lua_rawseti(IntPtr state, int index, int n);

    [DllImport(Lua, CallingConvention = CallingConvention.Cdecl)]
    private static extern void lua_setfield(IntPtr state, int index, string key);

    [DllImport(Lua, CallingConvention = CallingConvention.Cdecl)]
    private static extern void lua_close(IntPtr state);

    [DllImport(Lua, CallingConvention = CallingConvention.Cdecl)]
    private static extern int lua_type(IntPtr state, int index);

    [DllImport(Lua, CallingConvention = CallingConvention.Cdecl)]
    private static extern void lua_pushnil(IntPtr state);

    [DllImport(Lua, CallingConvention = CallingConvention.Cdecl)]
    private static extern void lua_pushcclosure(IntPtr state, IntPtr function, int upvalues);

    [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
    private delegate int LuaCFunction(IntPtr state);

    private const int LuaTypeString = 4;

    // Held in a static field so the GC never collects the delegate while Lua holds its pointer.
    private static readonly LuaCFunction InflateFunction = Inflate;

    // Pins the native Inflate: any later assignment of the global (the headless stub) is ignored.
    private const string InflatePin =
        "local native = __luahost_inflate " +
        "__luahost_inflate = nil " +
        "setmetatable(_G, { " +
        "__index = function(t, k) if k == 'Inflate' then return native end end, " +
        "__newindex = function(t, k, v) if k ~= 'Inflate' then rawset(t, k, v) end end })";

    // Runs arg[0] under xpcall so errors come back with a traceback; os.exit still works as usual.
    private const string Bootstrap =
        InflatePin + " " +
        "local f, e = loadfile(arg[0]) " +
        "if not f then io.stderr:write(e, '\\n') os.exit(2) end " +
        "local ok, err = xpcall(f, debug.traceback) " +
        "if not ok then io.stderr:write(tostring(err), '\\n') os.exit(1) end";

    private static int Main(string[] args)
    {
        if (args.Length < 3)
        {
            WriteError("usage: luahost <runtimeDir> <workDir> <script.lua> [args...]");
            return 64;
        }
        string runtimeDir = Path.GetFullPath(args[0]);
        string workDir = Path.GetFullPath(args[1]);
        string script = Path.GetFullPath(args[2]);

        SetDllDirectory(runtimeDir);
        if (LoadLibrary(Path.Combine(runtimeDir, Lua)) == IntPtr.Zero)
        {
            WriteError("could not load " + Path.Combine(runtimeDir, Lua) + " (error " + Marshal.GetLastWin32Error() + ")");
            return 65;
        }
        Directory.SetCurrentDirectory(workDir);

        IntPtr state = luaL_newstate();
        luaL_openlibs(state);

        lua_createtable(state, args.Length - 3, 1);
        PushString(state, script);
        lua_rawseti(state, -2, 0);
        for (int i = 3; i < args.Length; i++)
        {
            PushString(state, args[i]);
            lua_rawseti(state, -2, i - 2);
        }
        lua_setfield(state, LuaGlobalsIndex, "arg");

        lua_pushcclosure(state, Marshal.GetFunctionPointerForDelegate(InflateFunction), 0);
        lua_setfield(state, LuaGlobalsIndex, "__luahost_inflate");

        byte[] boot = Encoding.UTF8.GetBytes(Bootstrap);
        int status = luaL_loadbuffer(state, boot, (UIntPtr)boot.Length, "=luahost");
        if (status == 0)
        {
            status = lua_pcall(state, 0, 0, 0);
        }
        if (status != 0)
        {
            UIntPtr length;
            IntPtr message = lua_tolstring(state, -1, out length);
            WriteError(message == IntPtr.Zero ? "lua error" : Utf8String(message, (int)length));
        }
        lua_close(state);
        return status == 0 ? 0 : 1;
    }

    // Lua strings are UTF-8 here (the args are pushed as UTF-8, and PoB's lua51.dll opens files with _wfopen from
    // UTF-8), so an error naming a path like C:\Users\José\... must be decoded as UTF-8, not the ANSI code page (#70).
    private static string Utf8String(IntPtr pointer, int length)
    {
        byte[] bytes = new byte[length];
        Marshal.Copy(pointer, bytes, 0, length);
        return Encoding.UTF8.GetString(bytes);
    }

    // stderr as UTF-8 (no BOM), whatever the console code page: the engine client reads it as UTF-8.
    private static void WriteError(string text)
    {
        using (StreamWriter error = new StreamWriter(Console.OpenStandardError(), new UTF8Encoding(false)))
        {
            error.WriteLine(text);
        }
    }

    private static void PushString(IntPtr state, string text)
    {
        byte[] bytes = Encoding.UTF8.GetBytes(text);
        lua_pushlstring(state, bytes, (UIntPtr)bytes.Length);
    }

    // Inflate(data) -> string, or nil plus a message. Same contract as SimpleGraphic's: zlib or gzip
    // headers, detected automatically; raw DEFLATE isn't supported. Never lets an exception cross into Lua.
    private static int Inflate(IntPtr state)
    {
        try
        {
            if (lua_type(state, 1) != LuaTypeString)
            {
                return PushFailure(state, "Inflate: expected a string");
            }
            UIntPtr length;
            IntPtr pointer = lua_tolstring(state, 1, out length);
            byte[] input = new byte[(int)length];
            Marshal.Copy(pointer, input, 0, input.Length);
            byte[] output = InflateBytes(input);
            lua_pushlstring(state, output, (UIntPtr)output.Length);
            return 1;
        }
        catch (Exception error)
        {
            return PushFailure(state, "Inflate: " + error.Message);
        }
    }

    private static byte[] InflateBytes(byte[] input)
    {
        bool gzip = input.Length >= 2 && input[0] == 0x1f && input[1] == 0x8b;
        // zlib: CMF byte with method 8 (deflate), header checksum divisible by 31, no preset dictionary.
        bool zlib = input.Length >= 2 && (input[0] & 0x0f) == 8 && ((input[0] << 8) | input[1]) % 31 == 0 && (input[1] & 0x20) == 0;
        if (!gzip && !zlib)
        {
            throw new InvalidDataException("not zlib or gzip data");
        }
        using (MemoryStream source = gzip ? new MemoryStream(input) : new MemoryStream(input, 2, input.Length - 2))
        using (Stream decoder = gzip ? (Stream)new GZipStream(source, CompressionMode.Decompress) : new DeflateStream(source, CompressionMode.Decompress))
        using (MemoryStream result = new MemoryStream())
        {
            decoder.CopyTo(result);
            return result.ToArray();
        }
    }

    private static int PushFailure(IntPtr state, string message)
    {
        lua_pushnil(state);
        PushString(state, message);
        return 2;
    }
}
