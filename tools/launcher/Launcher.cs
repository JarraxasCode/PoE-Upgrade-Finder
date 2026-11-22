// The one exe friends run (PLAN.md, "Phase 5: shipping"). Built by tools/package/package.ts with the in-box
// csc.exe (.NET Framework 4.x, C# 5), with the whole app embedded as the resource "app.zip".
//
// - First launch of a version: a small "Setting up" window while app.zip unpacks to
//   %LOCALAPPDATA%\poe-upgrade-finder\app\<version>.partial, then a ".complete" marker is written and the folder
//   renamed to <version>. Later launches see the marker and start at once. Older versions are deleted.
// - Starts the app (Electron) and waits for it. If the app asks to be removed (Settings, "Remove from this PC":
//   it writes Local\remove-requested and exits with RemoveExitCode), deletes the Local and Roaming folders.
//   Both signals are needed, so a stray exit code never deletes anything.
// - A short text log is kept at Local\launcher.log for when something goes wrong on a friend's PC.

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Text;
using System.Threading;
using System.Windows.Forms;

namespace PoeUpgradeFinder.Launcher
{
    internal static class Program
    {
        private const string AppName = "poe-upgrade-finder";
        private const string Title = "PoE Upgrade Finder";
        /// <summary>Must match REMOVE_EXIT_CODE in apps/desktop (services/remove.ts).</summary>
        private const int RemoveExitCode = 86;
        private const string RemoveMarker = "remove-requested";
        private const string CompleteMarker = ".complete";

        private static string localRoot;
        private static string logPath;

        [STAThread]
        private static int Main(string[] args)
        {
            localRoot = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), AppName);
            logPath = Path.Combine(localRoot, "launcher.log");
            try
            {
                Directory.CreateDirectory(localRoot);
                Log("start " + BuildInfo.Version + " from " + Assembly.GetExecutingAssembly().Location);
                string appRoot = Path.Combine(localRoot, "app");
                string versionDir = Path.Combine(appRoot, BuildInfo.Version);

                using (Mutex mutex = new Mutex(false, "Local\\" + AppName + "-setup"))
                {
                    mutex.WaitOne();
                    try
                    {
                        if (!IsUnpacked(versionDir))
                        {
                            if (!Unpack(appRoot, versionDir))
                            {
                                return 1;
                            }
                        }
                    }
                    finally
                    {
                        mutex.ReleaseMutex();
                    }
                }
                DeleteOlderVersions(appRoot);
                return RunApp(versionDir, args);
            }
            catch (Exception error)
            {
                Log("error " + error);
                MessageBox.Show(
                    "PoE Upgrade Finder couldn't start:\n\n" + error.Message + "\n\nDetails are in " + logPath,
                    Title, MessageBoxButtons.OK, MessageBoxIcon.Error);
                return 1;
            }
        }

        private static void Log(string line)
        {
            try
            {
                FileInfo info = new FileInfo(logPath);
                if (info.Exists && info.Length > 256 * 1024)
                {
                    info.Delete();
                }
                File.AppendAllText(logPath, DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + " " + line + Environment.NewLine);
            }
            catch (Exception)
            {
                // A log that can't be written must not stop the app.
            }
        }

        // ---- Unpacking -------------------------------------------------------------------------------------

        /// <summary>
        /// Unpacked by this very build: the marker holds the build id, so a rebuilt exe with the same version
        /// (a quick fix, or a dev rebuild) unpacks again instead of running the old files.
        /// </summary>
        private static bool IsUnpacked(string versionDir)
        {
            try
            {
                string marker = Path.Combine(versionDir, CompleteMarker);
                return File.Exists(marker) && File.ReadAllText(marker).Trim() == BuildInfo.BuildId;
            }
            catch (Exception)
            {
                return false;
            }
        }

        private sealed class SetupForm : Form
        {
            public readonly ProgressBar Bar;

            public SetupForm()
            {
                this.Text = Title;
                this.FormBorderStyle = FormBorderStyle.FixedDialog;
                this.MaximizeBox = false;
                this.MinimizeBox = false;
                this.ControlBox = false;
                this.StartPosition = FormStartPosition.CenterScreen;
                this.Font = SystemFonts.MessageBoxFont;
                try
                {
                    // The exe's own icon (assets/icon/icon.ico, compiled in with /win32icon).
                    this.Icon = Icon.ExtractAssociatedIcon(Assembly.GetExecutingAssembly().Location);
                }
                catch (Exception)
                {
                    // The default icon is fine.
                }
                // The exe is per-monitor DPI aware, so lay out in device pixels scaled from 96 dpi, and let the
                // label size itself to its text (fixed bounds cut the second line off at 150%).
                float scale;
                using (Graphics g = this.CreateGraphics())
                {
                    scale = g.DpiX / 96f;
                }
                int pad = (int)(18 * scale);
                int width = (int)(380 * scale);
                Label label = new Label();
                label.AutoSize = true;
                label.MaximumSize = new Size(width, 0);
                label.Text = "Setting up PoE Upgrade Finder...\nThis happens once per version and takes a few seconds.";
                label.Location = new Point(pad, pad);
                this.Controls.Add(label);
                Size text = label.GetPreferredSize(new Size(width, 0));
                this.Bar = new ProgressBar();
                this.Bar.Maximum = 1000;
                this.Bar.SetBounds(pad, pad + text.Height + (int)(12 * scale), width, (int)(18 * scale));
                this.Controls.Add(this.Bar);
                this.ClientSize = new Size(width + 2 * pad, this.Bar.Bottom + pad);
            }
        }

        private static bool Unpack(string appRoot, string versionDir)
        {
            string partial = versionDir + ".partial";
            Exception failure = null;
            Application.EnableVisualStyles();
            SetupForm form = new SetupForm();
            form.Shown += delegate
            {
                Thread worker = new Thread(delegate ()
                {
                    try
                    {
                        Extract(partial, delegate (int permille)
                        {
                            form.BeginInvoke((MethodInvoker)delegate { form.Bar.Value = Math.Min(1000, permille); });
                        });
                        File.WriteAllText(Path.Combine(partial, CompleteMarker), BuildInfo.BuildId);
                        if (Directory.Exists(versionDir))
                        {
                            Directory.Delete(versionDir, true);
                        }
                        Directory.Move(partial, versionDir);
                    }
                    catch (Exception error)
                    {
                        failure = error;
                    }
                    form.BeginInvoke((MethodInvoker)delegate { form.Close(); });
                });
                worker.IsBackground = true;
                worker.Start();
            };
            Stopwatch watch = Stopwatch.StartNew();
            Application.Run(form);
            if (failure != null)
            {
                Log("unpack failed " + failure);
                TryDelete(partial);
                MessageBox.Show(
                    "Setting up failed:\n\n" + failure.Message + "\n\nCheck there's about 1 GB free on the system drive and try again. Details are in " + logPath,
                    Title, MessageBoxButtons.OK, MessageBoxIcon.Error);
                return false;
            }
            Log("unpacked " + BuildInfo.Version + " in " + watch.ElapsedMilliseconds + " ms");
            return true;
        }

        private static void Extract(string target, Action<int> progress)
        {
            TryDelete(target);
            Directory.CreateDirectory(target);
            string root = Path.GetFullPath(target) + Path.DirectorySeparatorChar;
            using (Stream resource = Assembly.GetExecutingAssembly().GetManifestResourceStream("app.zip"))
            {
                if (resource == null)
                {
                    throw new InvalidOperationException("this exe has no app inside (app.zip resource missing)");
                }
                using (ZipArchive archive = new ZipArchive(resource, ZipArchiveMode.Read))
                {
                    long total = 0;
                    foreach (ZipArchiveEntry entry in archive.Entries)
                    {
                        total += entry.Length;
                    }
                    long done = 0;
                    int lastReported = -1;
                    byte[] buffer = new byte[1 << 20];
                    foreach (ZipArchiveEntry entry in archive.Entries)
                    {
                        string path = Path.GetFullPath(Path.Combine(target, entry.FullName.Replace('/', Path.DirectorySeparatorChar)));
                        if (!path.StartsWith(root, StringComparison.OrdinalIgnoreCase))
                        {
                            throw new InvalidDataException("unsafe path in app.zip: " + entry.FullName);
                        }
                        if (entry.FullName.EndsWith("/"))
                        {
                            Directory.CreateDirectory(path);
                            continue;
                        }
                        Directory.CreateDirectory(Path.GetDirectoryName(path));
                        using (Stream input = entry.Open())
                        using (FileStream output = new FileStream(path, FileMode.CreateNew, FileAccess.Write, FileShare.None, 1 << 16))
                        {
                            int read;
                            while ((read = input.Read(buffer, 0, buffer.Length)) > 0)
                            {
                                output.Write(buffer, 0, read);
                                done += read;
                                int permille = total == 0 ? 1000 : (int)(done * 1000 / total);
                                if (permille != lastReported)
                                {
                                    lastReported = permille;
                                    progress(permille);
                                }
                            }
                        }
                    }
                }
            }
        }

        /// <summary>Deletes versions older than this one, and their leftover .partial folders. A newer one is kept.</summary>
        private static void DeleteOlderVersions(string appRoot)
        {
            Version mine = new Version(BuildInfo.Version);
            foreach (string dir in Directory.GetDirectories(appRoot))
            {
                string name = Path.GetFileName(dir);
                string bare = name.EndsWith(".partial") ? name.Substring(0, name.Length - ".partial".Length) : name;
                Version other;
                bool old = Version.TryParse(bare, out other) && other < mine;
                if (old)
                {
                    Log("deleting old version " + name);
                    TryDelete(dir);
                }
            }
        }

        // ---- Running ---------------------------------------------------------------------------------------

        private static int RunApp(string versionDir, string[] args)
        {
            string exe = Path.Combine(versionDir, BuildInfo.AppExe);
            ProcessStartInfo start = new ProcessStartInfo(exe);
            start.UseShellExecute = false;
            start.WorkingDirectory = versionDir;
            start.Arguments = JoinArgs(args);
            // VS Code and some tools set this; Electron would then run as plain Node (the fuse is off too).
            start.EnvironmentVariables.Remove("ELECTRON_RUN_AS_NODE");
            start.EnvironmentVariables["POE_UF_LAUNCHER"] = Assembly.GetExecutingAssembly().Location;
            string marker = Path.Combine(localRoot, RemoveMarker);
            TryDeleteFile(marker);
            using (Process app = Process.Start(start))
            {
                Log("started app pid " + app.Id);
                app.WaitForExit();
                int code = app.ExitCode;
                Log("app exited " + code);
                if (code == RemoveExitCode && File.Exists(marker))
                {
                    RemoveFromPc();
                }
                return code == RemoveExitCode ? 0 : code;
            }
        }

        private static string JoinArgs(string[] args)
        {
            List<string> quoted = new List<string>();
            foreach (string arg in args)
            {
                quoted.Add(Quote(arg));
            }
            return string.Join(" ", quoted.ToArray());
        }

        /// <summary>Quotes one argument the way CommandLineToArgvW reads it back.</summary>
        private static string Quote(string arg)
        {
            if (arg.Length > 0 && arg.IndexOfAny(new char[] { ' ', '\t', '"' }) < 0)
            {
                return arg;
            }
            StringBuilder text = new StringBuilder("\"");
            int slashes = 0;
            foreach (char c in arg)
            {
                if (c == '\\')
                {
                    slashes++;
                    continue;
                }
                text.Append('\\', c == '"' ? slashes * 2 + 1 : slashes);
                text.Append(c);
                slashes = 0;
            }
            text.Append('\\', slashes * 2);
            text.Append('"');
            return text.ToString();
        }

        // ---- Remove from this PC ---------------------------------------------------------------------------

        private static void RemoveFromPc()
        {
            string roaming = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), AppName);
            Log("removing " + localRoot + " and " + roaming);
            // The app's helper processes (GPU, renderers, PoB workers) can take a moment to let go of files.
            List<string> left = new List<string>();
            foreach (string dir in new string[] { roaming, localRoot })
            {
                for (int attempt = 0; attempt < 20 && Directory.Exists(dir); attempt++)
                {
                    TryDelete(dir);
                    if (Directory.Exists(dir))
                    {
                        Thread.Sleep(500);
                    }
                }
                if (Directory.Exists(dir))
                {
                    left.Add(dir);
                }
            }
            if (left.Count == 0)
            {
                MessageBox.Show(
                    "PoE Upgrade Finder's files and settings are removed from this PC.\n\nYou can delete this exe now:\n" + Assembly.GetExecutingAssembly().Location,
                    Title, MessageBoxButtons.OK, MessageBoxIcon.Information);
            }
            else
            {
                MessageBox.Show(
                    "Some files couldn't be removed (still in use?). Close everything and delete these folders by hand:\n\n" + string.Join("\n", left.ToArray()),
                    Title, MessageBoxButtons.OK, MessageBoxIcon.Warning);
            }
        }

        private static void TryDelete(string dir)
        {
            try
            {
                if (Directory.Exists(dir))
                {
                    Directory.Delete(dir, true);
                }
            }
            catch (Exception error)
            {
                Log("couldn't delete " + dir + ": " + error.Message);
            }
        }

        private static void TryDeleteFile(string path)
        {
            try
            {
                File.Delete(path);
            }
            catch (Exception)
            {
                // Not there, or locked: the exit code alone never removes anything.
            }
        }
    }
}
