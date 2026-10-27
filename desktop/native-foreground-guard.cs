using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

// Observes the normal Windows desktop. This does not lock foreground policy,
// inject input, inject into applications, or create another desktop.
public static class BlackiceForegroundGuard {
    [StructLayout(LayoutKind.Sequential)] struct Point {public int X,Y;}
    [StructLayout(LayoutKind.Sequential)] struct Message {public IntPtr hwnd;public uint message;public UIntPtr wParam;public IntPtr lParam;public uint time;public Point point;public uint privateValue;}
    [StructLayout(LayoutKind.Sequential)] struct LastInput {public uint size,time;}
    [StructLayout(LayoutKind.Sequential)] struct ThreadInfo {public uint size,flags;public IntPtr active,focus,capture,menuOwner,moveSize,caret;public int left,top,right,bottom;}
    delegate void EventProcedure(IntPtr hook,uint kind,IntPtr hwnd,int objectId,int childId,uint thread,uint time);
    [DllImport("user32.dll")] static extern IntPtr SetWinEventHook(uint first,uint last,IntPtr module,EventProcedure callback,uint process,uint thread,uint flags);
    [DllImport("user32.dll")] static extern bool UnhookWinEvent(IntPtr hook);
    [DllImport("user32.dll")] static extern int GetMessageW(out Message message,IntPtr hwnd,uint min,uint max);
    [DllImport("user32.dll")] static extern bool PostThreadMessageW(uint thread,uint message,UIntPtr wParam,IntPtr lParam);
    [DllImport("user32.dll")] static extern bool PeekMessageW(out Message message,IntPtr hwnd,uint min,uint max,uint remove);
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
    [DllImport("kernel32.dll")] static extern uint GetTickCount();
    [DllImport("user32.dll")] static extern bool GetLastInputInfo(ref LastInput value);
    [DllImport("user32.dll")] static extern bool GetGUIThreadInfo(uint thread,ref ThreadInfo value);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd,out uint pid);
    [DllImport("user32.dll")] static extern bool IsWindow(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hwnd);
    [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access,bool inherit,uint pid);
    [DllImport("kernel32.dll")] static extern bool GetProcessTimes(IntPtr process,out long created,out long exited,out long kernel,out long user);
    [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr process,uint timeout);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr process);
    public class WindowIdentity {public string windowId,processStartedAt;public int pid;}
    public class Lifetime {public IntPtr handle;public string started;}
    public class Observation {public long sequence;public string at,windowId,processStartedAt,focusWindowId,focusProcessStartedAt,decision="observed",restoreWindowId,restoreProcessStartedAt;public int pid,focusPid,restorePid;public uint eventTime,lastInputTime,previousInputTime;public bool attempted,restored,restorationRequested;public WindowIdentity previous;}
    public class Snapshot {public bool active,identityComplete,continuous=true,zeroFlashGuaranteed=false,journalTruncated;public string operationId,logPath,bindingStatus,journalError,limitation="Recovery follows an observed activation; an application may switch focus briefly. Recent human input or a newer foreground choice always wins. Foreground events do not measure window showing or physical screen visibility.";public long sequence,journalObservedRows,journalOmittedRows,journalUnwrittenRows,journalBytes,journalCompactions,retiredLifetimeCount;public int verifiedProcessCount,cachedProcessCount;public Observation[] events;}
    // The same small helpers are exercised without a hook or desktop focus in
    // resource-boundary tests. Disk writes append normally; only crossing the
    // byte budget compacts to the last retained rows and an omission marker.
    public sealed class RollingJournal {
        public const int RowLimit=256,MaximumBytes=1024*1024;
        const int MarkerBudget=1024;
        readonly string file;readonly Queue<string> rows=new Queue<string>();readonly UTF8Encoding encoding=new UTF8Encoding(false);
        bool initialized;int retainedBytes;
        public long observedRows,journaledRows,omittedRows,compactions,fileBytes,appendWrites;
        public string error;
        public int BufferedRows {get{return rows.Count;}}
        public RollingJournal(string path){file=path;}
        public void Append(string row){
            observedRows++;
            if(error!=null||String.IsNullOrEmpty(file))return;
            string line=row+"\n";int bytes=encoding.GetByteCount(line);
            if(bytes>MaximumBytes-MarkerBudget){error="A foreground journal row exceeded its bounded record size.";return;}
            rows.Enqueue(line);retainedBytes+=bytes;
            while(rows.Count>RowLimit||retainedBytes>MaximumBytes-MarkerBudget)retainedBytes-=encoding.GetByteCount(rows.Dequeue());
            string temporary=null;
            try{
                // Each operation has its own path. Never silently overwrite a
                // previous operation if a caller supplies an existing file.
                if(!initialized){using(var created=new FileStream(file,FileMode.CreateNew,FileAccess.Write,FileShare.Read)){}initialized=true;}
                if(fileBytes+bytes<=MaximumBytes){File.AppendAllText(file,line,encoding);fileBytes+=bytes;appendWrites++;}
                else{
                    long omitted=observedRows-rows.Count;
                    string marker="{\"kind\":\"journal_retention\",\"retainedRows\":"+rows.Count+",\"omittedRows\":"+omitted+",\"observedRows\":"+observedRows+",\"compactions\":"+(compactions+1)+",\"maximumBytes\":"+MaximumBytes+"}\n";
                    var content=new StringBuilder(marker);foreach(string retained in rows)content.Append(retained);
                    string compacted=content.ToString();
                    temporary=file+"."+Guid.NewGuid().ToString("N")+".tmp";
                    File.WriteAllText(temporary,compacted,encoding);File.Replace(temporary,file,null);temporary=null;
                    fileBytes=encoding.GetByteCount(compacted);omittedRows=omitted;compactions++;
                }
                journaledRows++;
            }catch(IOException failure){error=failure.GetType().Name+": "+failure.Message;}
            catch(UnauthorizedAccessException failure){error=failure.GetType().Name+": "+failure.Message;}
            finally{if(temporary!=null)try{File.Delete(temporary);}catch(IOException){}catch(UnauthorizedAccessException){}}
        }
    }
    public sealed class LifetimeCache {
        readonly Dictionary<uint,Lifetime> entries=new Dictionary<uint,Lifetime>();readonly Action<IntPtr> release;
        int additions;public long retiredCount;
        public int Count {get{return entries.Count;}}
        public bool NeedsPrune {get{return additions>=32;}}
        public LifetimeCache(Action<IntPtr> close){release=close;}
        public bool TryGetValue(uint pid,out Lifetime value){return entries.TryGetValue(pid,out value);}
        public void Put(uint pid,Lifetime value){Remove(pid);entries[pid]=value;additions++;}
        public void Remove(uint pid){Lifetime value;if(!entries.TryGetValue(pid,out value))return;entries.Remove(pid);if(value.handle!=IntPtr.Zero)release(value.handle);retiredCount++;}
        public void Prune(ICollection<uint> retained,bool force){if(!force&&additions<32)return;var discarded=new List<uint>();foreach(uint pid in entries.Keys)if(!retained.Contains(pid))discarded.Add(pid);foreach(uint pid in discarded)Remove(pid);additions=0;}
        public void Clear(){foreach(var value in entries.Values)if(value.handle!=IntPtr.Zero)release(value.handle);retiredCount+=entries.Count;entries.Clear();additions=0;}
    }
    static readonly object sync=new object();
    static readonly EventProcedure callback=OnForeground;
    static readonly LifetimeCache lifetimes=new LifetimeCache(delegate(IntPtr handle){CloseHandle(handle);});
    static readonly Dictionary<int,string> owned=new Dictionary<int,string>();
    static readonly List<Observation> observations=new List<Observation>();
    static Thread thread;static uint threadId;static IntPtr hook,hostWindow;static WindowIdentity legitimate;
    static uint legitimateInput;static long sequence;static DateTime allowUntil,lastRecovery;static string operationId,logPath,bindingStatus;static bool active,identityComplete=true;static RollingJournal journal;
    static uint InputTime(){var value=new LastInput {size=(uint)Marshal.SizeOf(typeof(LastInput))};return GetLastInputInfo(ref value)?value.time:0;}
    static string ProcessStarted(uint pid){if(pid==0)return null;Lifetime lifetime;if(lifetimes.TryGetValue(pid,out lifetime)){if(lifetime.handle!=IntPtr.Zero&&WaitForSingleObject(lifetime.handle,0)==258)return lifetime.started;lifetimes.Remove(pid);}IntPtr handle=OpenProcess(0x00101000,false,pid);long created,exited,kernel,user;if(handle==IntPtr.Zero||!GetProcessTimes(handle,out created,out exited,out kernel,out user)){if(handle!=IntPtr.Zero)CloseHandle(handle);return null;}var started=DateTime.FromFileTimeUtc(created).ToString("O");lifetimes.Put(pid,new Lifetime {handle=handle,started=started});return started;}
    static void RetainProcess(HashSet<uint> retained,int pid){if(pid>0)retained.Add((uint)pid);}
    public static HashSet<uint> RetainedProcesses(IEnumerable<Observation> history,WindowIdentity prior,IDictionary<int,string> verified){
        var retained=new HashSet<uint>();if(prior!=null)RetainProcess(retained,prior.pid);
        foreach(int pid in verified.Keys)RetainProcess(retained,pid);
        foreach(var value in history){RetainProcess(retained,value.pid);RetainProcess(retained,value.focusPid);RetainProcess(retained,value.restorePid);if(value.previous!=null)RetainProcess(retained,value.previous.pid);}
        return retained;
    }
    static void PruneLifetimes(bool force){if(force||lifetimes.NeedsPrune)lifetimes.Prune(RetainedProcesses(observations,legitimate,owned),force);}
    static WindowIdentity Identify(IntPtr hwnd,bool allowUnknown=false){if(hwnd==IntPtr.Zero||!IsWindow(hwnd))return null;uint pid;GetWindowThreadProcessId(hwnd,out pid);string started=ProcessStarted(pid);return started==null&&!allowUnknown?null:new WindowIdentity {windowId=hwnd.ToInt64().ToString(),pid=(int)pid,processStartedAt=started};}
    public static bool ExactProcessLifetime(int firstPid,string firstStarted,int secondPid,string secondStarted){return firstPid>0&&firstPid==secondPid&&!String.IsNullOrEmpty(firstStarted)&&firstStarted==secondStarted;}
    static bool Same(WindowIdentity a,WindowIdentity b){return a!=null&&b!=null&&a.windowId==b.windowId&&ExactProcessLifetime(a.pid,a.processStartedAt,b.pid,b.processStartedAt);}
    static bool Owned(int pid,string started){string expected;return started!=null&&owned.TryGetValue(pid,out expected)&&started==expected;}
    static bool Owned(WindowIdentity value){return value!=null&&Owned(value.pid,value.processStartedAt);}
    static bool ProvenOwned(Observation value){return Owned(value.pid,value.processStartedAt)||(value.windowId==hostWindow.ToInt64().ToString()&&Owned(value.focusPid,value.focusProcessStartedAt));}
    static WindowIdentity EventWindow(Observation value){return new WindowIdentity {windowId=value.windowId,pid=value.pid,processStartedAt=value.processStartedAt};}
    // Kept pure so routine tests exercise the actual recovery admission policy
    // without installing a hook or moving any desktop focus.
    public static string Decide(bool ownedEvent,bool previousOwned,bool explicitFocus,bool recentChangedInput,bool sameEpoch,bool sameCurrent,bool previousAlive,bool attempted){if(!ownedEvent)return "unrelated";if(attempted)return "already_attempted";if(previousOwned)return "already_using_application";if(explicitFocus)return "explicit_focus";if(recentChangedInput)return "human_input";if(!sameEpoch||!sameCurrent)return "superseded";if(!previousAlive)return "previous_unavailable";return "recover";}
    public static bool HumanInputSupersedes(uint eventTime,uint inputTime,uint previousInputTime){
        // WinEvent callbacks can be queued while physical input continues. A
        // newer input wins even if it arrived before callback delivery. Signed
        // tick deltas preserve this ordering across the 32-bit tick wrap.
        int ageAtEvent=unchecked((int)(eventTime-inputTime));
        return ageAtEvent<0||(inputTime!=previousInputTime&&ageAtEvent<=750);
    }
    static void Recover(Observation value){
        bool current=Same(EventWindow(value),Identify(GetForegroundWindow()));
        bool human=HumanInputSupersedes(value.eventTime,value.lastInputTime,legitimateInput);
        // A human input arriving after observation also supersedes this event.
        if(InputTime()!=value.lastInputTime)human=true;
        WindowIdentity previous=value.previous;bool alive=previous!=null&&Same(previous,Identify(new IntPtr(long.Parse(previous.windowId))));
        if(value.lastInputTime==0){value.decision="input_unavailable";return;}
        if(Same(previous,EventWindow(value))){value.decision="same_foreground_window";return;}
        string decision=Decide(ProvenOwned(value),Owned(previous),DateTime.UtcNow<allowUntil,human,value.sequence==sequence,current,alive,value.attempted);
        value.decision=decision;if(decision!="recover")return;
        if(DateTime.UtcNow-lastRecovery<TimeSpan.FromSeconds(1)){value.decision="recovery_burst_yield";return;}
        value.attempted=true;value.restoreWindowId=previous.windowId;value.restorePid=previous.pid;value.restoreProcessStartedAt=previous.processStartedAt;
        // One attempt for this exact event and HWND/process lifetime. Never
        // raise BLACKICE as a replacement target; only the actual prior window
        // can be restored, and only while the same event still owns foreground.
        if(value.sequence!=sequence||!Same(EventWindow(value),Identify(GetForegroundWindow()))||InputTime()!=value.lastInputTime){value.decision="superseded";return;}
        lastRecovery=DateTime.UtcNow;value.restorationRequested=SetForegroundWindow(new IntPtr(long.Parse(previous.windowId)));
        value.restored=Same(previous,Identify(GetForegroundWindow()));value.decision=value.restored?"restored":"restore_denied";
    }
    static string Quote(string value){return value==null?"null":"\""+value.Replace("\\","\\\\").Replace("\"","\\\"").Replace("\r","\\r").Replace("\n","\\n")+"\"";}
    static void Journal(Observation value){if(journal==null)return;journal.Append("{\"sequence\":"+value.sequence+",\"at\":"+Quote(value.at)+",\"eventTime\":"+value.eventTime+",\"lastInputTime\":"+value.lastInputTime+",\"previousInputTime\":"+value.previousInputTime+",\"windowId\":"+Quote(value.windowId)+",\"pid\":"+value.pid+",\"processStartedAt\":"+Quote(value.processStartedAt)+",\"focusWindowId\":"+Quote(value.focusWindowId)+",\"focusPid\":"+value.focusPid+",\"focusProcessStartedAt\":"+Quote(value.focusProcessStartedAt)+",\"decision\":"+Quote(value.decision)+",\"attempted\":"+value.attempted.ToString().ToLowerInvariant()+",\"restorationRequested\":"+value.restorationRequested.ToString().ToLowerInvariant()+",\"restored\":"+value.restored.ToString().ToLowerInvariant()+",\"restoreWindowId\":"+Quote(value.restoreWindowId)+",\"restorePid\":"+value.restorePid+",\"restoreProcessStartedAt\":"+Quote(value.restoreProcessStartedAt)+"}");}
    static void OnForeground(IntPtr ignored,uint kind,IntPtr hwnd,int objectId,int childId,uint eventThread,uint eventTime){try{lock(sync){if(!active)return;var identity=Identify(hwnd,true);if(identity==null)identity=new WindowIdentity {windowId=hwnd.ToInt64().ToString()};var info=new ThreadInfo {size=(uint)Marshal.SizeOf(typeof(ThreadInfo))};WindowIdentity focus=GetGUIThreadInfo(0,ref info)?Identify(info.focus,true):null;
        var value=new Observation {sequence=++sequence,at=DateTime.UtcNow.ToString("O"),eventTime=eventTime,lastInputTime=InputTime(),previousInputTime=legitimateInput,windowId=identity.windowId,pid=identity.pid,processStartedAt=identity.processStartedAt,focusWindowId=focus==null?null:focus.windowId,focusPid=focus==null?0:focus.pid,focusProcessStartedAt=focus==null?null:focus.processStartedAt,previous=legitimate};
        observations.Add(value);if(observations.Count>256)observations.RemoveAt(0);if(String.IsNullOrEmpty(identity.processStartedAt)){identityComplete=false;value.decision="identity_unavailable";legitimate=null;legitimateInput=value.lastInputTime;}else Recover(value);
        if(!String.IsNullOrEmpty(identity.processStartedAt)&&(!ProvenOwned(value)||value.decision=="human_input"||value.decision=="explicit_focus")){legitimate=identity;legitimateInput=value.lastInputTime;}
        Journal(value);PruneLifetimes(false);
    }}catch(Exception){lock(sync){identityComplete=false;var failed=new Observation {sequence=++sequence,at=DateTime.UtcNow.ToString("O"),eventTime=eventTime,windowId=hwnd.ToInt64().ToString(),decision="observation_error"};observations.Add(failed);if(observations.Count>256)observations.RemoveAt(0);Journal(failed);PruneLifetimes(false);}}}
    static void EnsureThread(){if(thread!=null)return;var ready=new ManualResetEvent(false);Exception failure=null;thread=new Thread(delegate(){try{threadId=GetCurrentThreadId();Message seed;PeekMessageW(out seed,IntPtr.Zero,0,0,0);hook=SetWinEventHook(3,3,IntPtr.Zero,callback,0,0,0);if(hook==IntPtr.Zero)throw new InvalidOperationException("Windows foreground event tracking could not start.");ready.Set();Message message;while(GetMessageW(out message,IntPtr.Zero,0,0)>0){} }catch(Exception error){failure=error;ready.Set();}finally{if(hook!=IntPtr.Zero)UnhookWinEvent(hook);hook=IntPtr.Zero;}});thread.IsBackground=true;thread.SetApartmentState(ApartmentState.STA);thread.Start();if(!ready.WaitOne(5000))throw new InvalidOperationException("Windows foreground tracking did not acknowledge startup.");ready.Dispose();if(failure!=null)throw failure;}
    public static Snapshot Begin(string host,string file){EnsureThread();lock(sync){hostWindow=String.IsNullOrEmpty(host)?IntPtr.Zero:new IntPtr(long.Parse(host));operationId=Guid.NewGuid().ToString("N");logPath=file;journal=String.IsNullOrEmpty(file)?null:new RollingJournal(file);owned.Clear();observations.Clear();identityComplete=true;bindingStatus="pending_identity";allowUntil=DateTime.MinValue;lastRecovery=DateTime.MinValue;legitimate=Identify(GetForegroundWindow());legitimateInput=InputTime();PruneLifetimes(true);active=true;return Status();}}
    public static Snapshot Bind(int pid,string expectedStarted,string window,bool retain){lock(sync){if(!active)throw new InvalidOperationException("Foreground tracking must start before activation.");WindowIdentity identity=String.IsNullOrEmpty(window)?null:Identify(new IntPtr(long.Parse(window)));if(!String.IsNullOrEmpty(window)&&identity==null){bindingStatus="window_unavailable";return Status();}if(identity!=null)pid=identity.pid;string started=identity==null?ProcessStarted((uint)pid):identity.processStartedAt;if(pid<=0||started==null||identity==null&&!ExactProcessLifetime(pid,expectedStarted,pid,started)){bindingStatus="process_lifetime_unverified";return Status();}if(retain)owned.Clear();owned[pid]=started;bindingStatus="verified";
        // Activation may precede its shell receipt. Reclassify observed events,
        // but recover only the latest still-current exact event, never replay.
        WindowIdentity prior=null;uint priorInput=legitimateInput;foreach(var value in observations){if(!ProvenOwned(value)){prior=String.IsNullOrEmpty(value.processStartedAt)?null:EventWindow(value);priorInput=value.lastInputTime;}else if(prior==null&&value.previous!=null&&!Owned(value.previous)){prior=value.previous;priorInput=value.previousInputTime;}}
        if(observations.Count>0){var latest=observations[observations.Count-1];if(ProvenOwned(latest)){latest.previous=prior;legitimateInput=priorInput;Recover(latest);Journal(latest);}}
        return Status();}}
    public static Snapshot AllowFocus(){lock(sync){allowUntil=DateTime.UtcNow.AddSeconds(2);return Status();}}
    public static Snapshot Release(){lock(sync){active=false;owned.Clear();PruneLifetimes(true);return Status();}}
    public static Snapshot Status(){lock(sync){PruneLifetimes(false);return new Snapshot {active=active,identityComplete=identityComplete,bindingStatus=bindingStatus,verifiedProcessCount=owned.Count,cachedProcessCount=lifetimes.Count,retiredLifetimeCount=lifetimes.retiredCount,operationId=operationId,logPath=logPath,sequence=sequence,journalTruncated=journal!=null&&journal.omittedRows>0,journalObservedRows=journal==null?0:journal.observedRows,journalOmittedRows=journal==null?0:journal.omittedRows,journalUnwrittenRows=journal==null?0:journal.observedRows-journal.journaledRows,journalBytes=journal==null?0:journal.fileBytes,journalCompactions=journal==null?0:journal.compactions,journalError=journal==null?null:journal.error,events=observations.GetRange(Math.Max(0,observations.Count-32),Math.Min(32,observations.Count)).ToArray()};}}
    public static void Close(){lock(sync){active=false;}if(threadId!=0)PostThreadMessageW(threadId,0x0012,UIntPtr.Zero,IntPtr.Zero);if(thread!=null)thread.Join(2000);lock(sync){lifetimes.Clear();}}
}
