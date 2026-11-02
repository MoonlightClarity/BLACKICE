// BLACKICE Workbench interactive guest display transport.
// Capture occurs only in the guest's logged-in Windows session. Frames travel
// outbound over Hyper-V's virtual network, not through the host display.
package main

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"github.com/gen2brain/jpegn"
	"net"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"time"
	"unsafe"

	"github.com/go-mswin/screencapture"
)

const maxFrameBytes = 4_000_000

type hostInfo struct { HostName string `json:"hostName"` }
type viewerInfo struct {
	Version int `json:"version"`
	Active bool `json:"active"`
	At time.Time `json:"at"`
}
type transportInfo struct {
	Version int `json:"version"`
	HostIP string `json:"hostIp"`
	Port int `json:"port"`
	Token string `json:"token"`
}
type statusInfo struct {
	Version int `json:"version"`
	At string `json:"at"`
	Guest string `json:"guest"`
	SessionID uint32 `json:"sessionId"`
	Active bool `json:"active"`
	TCPConnected bool `json:"tcpConnected"`
	Backend string `json:"backend"`
	Note string `json:"backendNote,omitempty"`
	Resolution string `json:"resolution,omitempty"`
	FramesSent uint64 `json:"framesSent"`
	FramesLastInterval int `json:"framesLastInterval"`
	FPS float64 `json:"fps"`
	CaptureFPS float64 `json:"captureFPS"`
	CaptureFrames uint64 `json:"captureFrames"`
	CaptureSuperseded uint64 `json:"captureSuperseded"`
	MeanCaptureMS float64 `json:"meanCaptureMs"`
	EncodeMS float64 `json:"meanEncodeMs"`
	SendMS float64 `json:"meanSendMs"`
	Error string `json:"error,omitempty"`
}

func sessionID() (uint32, error) {
	proc := syscall.NewLazyDLL("kernel32.dll").NewProc("ProcessIdToSessionId")
	var id uint32
	ok, _, err := proc.Call(uintptr(os.Getpid()), uintptr(unsafe.Pointer(&id)))
	if ok == 0 { return 0, fmt.Errorf("guest session unavailable: %v", err) }
	if id == 0 { return 0, errors.New("a signed-in guest desktop is required") }
	return id, nil
}
func verifyGuest(root string) (string,string,uint32,error) {
	if !filepath.IsAbs(root) { return "","",0,errors.New("workspace must be a mapped absolute path") }
	dir := filepath.Join(root,".blackice-workbench")
	b,err := os.ReadFile(filepath.Join(dir,"host-info.json"))
	if err != nil {return "","",0,fmt.Errorf("missing guest workspace identity: %w",err)}
	var info hostInfo
	if json.Unmarshal(b,&info)!=nil || info.HostName=="" {return "","",0,errors.New("guest host-info.json invalid")}
	name,err := os.Hostname()
	if err!=nil || strings.EqualFold(info.HostName,name) {return "","",0,errors.New("this is not the Windows guest")}
	id,err := sessionID()
	if err!=nil {return "","",0,err}
	return filepath.Join(dir,"desktop-stream"),name,id,nil
}
func viewerActive(folder string,now time.Time) bool {
	b,err := os.ReadFile(filepath.Join(folder,"viewer.json"))
	if err!=nil || len(b)>2048 {return false}
	var v viewerInfo
	if json.Unmarshal(b,&v)!=nil || v.Version!=1 || !v.Active {return false}
	d := now.Sub(v.At)
	return d >= -5*time.Second && d < 5*time.Second
}
func guestTransport(folder string) (transportInfo,error) {
	var cfg transportInfo
	b,err := os.ReadFile(filepath.Join(folder,"transport.json"))
	if err!=nil{return cfg,err}
	if len(b)>4096 || json.Unmarshal(b,&cfg)!=nil || cfg.Version!=1 ||
		cfg.Port<1024 || cfg.Port>65535 || len(cfg.Token)!=48 {
		return cfg,errors.New("guest display transport configuration is invalid")
	}
	if ip:=net.ParseIP(cfg.HostIP); ip==nil || ip.To4()==nil {return cfg,errors.New("host IPv4 invalid")}
	for _,ch:=range cfg.Token { if !strings.ContainsRune("0123456789abcdef",ch){return cfg,errors.New("host video token invalid")} }
	return cfg,nil
}
func writeAll(c net.Conn,b []byte) error {
	for len(b)>0 {
		n,err:=c.Write(b)
		if err!=nil{return err}
		if n<=0{return errors.New("guest video socket returned no bytes")}
		b=b[n:]
	}
	return nil
}
func connect(folder string) (net.Conn,error) {
	cfg,err:=guestTransport(folder)
	if err!=nil{return nil,err}
	c,err:=net.DialTimeout("tcp4",net.JoinHostPort(cfg.HostIP,fmt.Sprint(cfg.Port)),900*time.Millisecond)
	if err!=nil{return nil,err}
	_ = c.SetWriteDeadline(time.Now().Add(2*time.Second))
	if err=writeAll(c,[]byte("BIV1 "+cfg.Token+"\n"));err!=nil {
		_ = c.Close();return nil,err
	}
	_ = c.SetWriteDeadline(time.Time{})
	return c,nil
}
func send(c net.Conn,frame []byte,w,h int) error {
	if len(frame)<200 || len(frame)>maxFrameBytes || w<160 || h<120 || w>7680 || h>4320 {
		return errors.New("guest frame outside supported video bounds")
	}
	var header [8]byte
	binary.BigEndian.PutUint32(header[:4],uint32(len(frame)))
	binary.BigEndian.PutUint16(header[4:6],uint16(w))
	binary.BigEndian.PutUint16(header[6:8],uint16(h))
	_ = c.SetWriteDeadline(time.Now().Add(2500*time.Millisecond))
	if err:=writeAll(c,header[:]);err!=nil{return err}
	return writeAll(c,frame)
}
func record(folder string,st statusInfo) {
	st.Version=1;st.At=time.Now().UTC().Format(time.RFC3339Nano)
	b,e:=json.Marshal(st)
	if e==nil {
		_ = os.WriteFile(filepath.Join(folder,"native-status.json"),b,0644)
	}
}

func main() {
	root:=flag.String("root","W:\\","mapped guest workspace")
	fps:=flag.Float64("fps",30,"maximum FPS (2–60)")
	quality:=flag.Int("quality",65,"JPEG quality (35–90)")
	backendName:=flag.String("backend","auto","auto, dxgi, or gdi")
	flag.Parse()
	if *fps<2 || *fps>60 || *quality<35 || *quality>90 {fmt.Fprintln(os.Stderr,"guest video settings out of range");os.Exit(2)}
	folder,guest,session,err:=verifyGuest(*root)
	if err!=nil {fmt.Fprintln(os.Stderr,err);os.Exit(3)}
	var backend screencapture.Backend
	switch strings.ToLower(*backendName) {
	case "auto": backend=screencapture.BackendAuto
	case "dxgi": backend=screencapture.BackendDuplication
	case "gdi": backend=screencapture.BackendGDI
	default: fmt.Fprintln(os.Stderr,"unknown capture backend");os.Exit(2)
	}
	if err=os.MkdirAll(folder,0755);err!=nil {fmt.Fprintln(os.Stderr,err);os.Exit(4)}
	st:=statusInfo{Guest:guest,SessionID:session,Backend:backend.String()}
	record(folder,st)
	ticker:=time.NewTicker(25*time.Millisecond)
	defer ticker.Stop()
	var stream *screencapture.Stream
	var conn net.Conn
	defer func(){
		if stream!=nil{_ = stream.Close()}
		if conn!=nil{_ = conn.Close()}
	}()
	var jpg []byte
	var width,height int
	var lastSent,timeWindow,lastViewerCheck,nextConnect,nextCapture time.Time
	var framesInWindow int
	var lastCaptureFrames uint64
	var lastCaptureTotal time.Duration
	var totalEncode,totalSend time.Duration
	timeWindow=time.Now()
	active:=false
	for now:=range ticker.C {
		if now.Sub(lastViewerCheck)>350*time.Millisecond {
			lastViewerCheck=now
			active=viewerActive(folder,now)
			st.Active=active
		}
		if !active {
			if conn!=nil{_ = conn.Close();conn=nil}
			if stream!=nil{_ = stream.Close();stream=nil}
			st.TCPConnected=false;jpg=nil
		} else {
			if conn==nil && !now.Before(nextConnect) {
				conn,err=connect(folder)
				if err!=nil {
					st.Error="video host unavailable: "+err.Error()
					nextConnect=now.Add(time.Second)
				} else {
					st.TCPConnected=true;st.Error=""
				}
			}
			if stream==nil && !now.Before(nextCapture) {
				displays,errList:=screencapture.Displays(context.Background())
				if errList!=nil || len(displays)==0 {
					st.Error="guest display not ready"
					nextCapture=now.Add(time.Second)
				} else {
					stream,err=screencapture.CaptureDisplay(context.Background(),displays[0],
						screencapture.Options{FPS:*fps,Backend:backend,QueueDepth:3,Timeout:100*time.Millisecond})
					if err!=nil {
						st.Error="capture failed: "+err.Error()
						nextCapture=now.Add(time.Second)
					} else {
						st.Backend=stream.Backend().String()
						st.Note=stream.Note()
						st.Error=""
					}
				}
			}
			if conn!=nil && stream!=nil {
				frame,fresh:=stream.Frame()
				if fresh && frame.Valid() {
					start:=time.Now()
					img,err:=frame.NRGBAOpaque()
					if err==nil {
						var buffer bytes.Buffer
						err=jpegn.Encode(&buffer,img,&jpegn.EncodeOptions{Quality:*quality})
						if err==nil {
							totalEncode+=time.Since(start)
							jpg=append(jpg[:0],buffer.Bytes()...)
							width,height=frame.Width,frame.Height
						}
					}
					if err!=nil {st.Error=err.Error()}
				} else if len(jpg)==0 || now.Sub(lastSent)<time.Second {
					// DXGI does not yield new frames while the guest desktop is static.
				}
				if len(jpg)>0 && (fresh || now.Sub(lastSent)>=time.Second) {
					start:=time.Now()
					err=send(conn,jpg,width,height)
					totalSend+=time.Since(start)
					if err!=nil {
						_ = conn.Close();conn=nil
						st.TCPConnected=false
						st.Error="TCP stream interrupted"
						nextConnect=now.Add(time.Second)
					} else {
						lastSent=now
						st.FramesSent++;framesInWindow++
						st.Resolution=fmt.Sprintf("%dx%d",width,height)
					}
				}
			}
		}
		if now.Sub(timeWindow)>=3*time.Second {
			duration:=now.Sub(timeWindow).Seconds()
			st.FramesLastInterval=framesInWindow
			st.FPS=float64(framesInWindow)/duration
			if stream!=nil {
				stats:=stream.Stats()
				if stats.Frames<lastCaptureFrames || stats.CaptureTotal<lastCaptureTotal {
					lastCaptureFrames=0
					lastCaptureTotal=0
				}
				newCaptures:=stats.Frames-lastCaptureFrames
				st.CaptureFPS=float64(newCaptures)/duration
				st.CaptureFrames=stats.Frames
				st.CaptureSuperseded=stats.Superseded
				if newCaptures>0 {
					st.MeanCaptureMS=float64((stats.CaptureTotal-lastCaptureTotal).Microseconds())/float64(newCaptures)/1000
				}
				lastCaptureFrames=stats.Frames
				lastCaptureTotal=stats.CaptureTotal
			} else {
				st.CaptureFPS=0; st.CaptureFrames=0; st.CaptureSuperseded=0; st.MeanCaptureMS=0
				lastCaptureFrames=0; lastCaptureTotal=0
			}
			if framesInWindow>0 {
				st.EncodeMS=float64(totalEncode.Microseconds())/float64(framesInWindow)/1000
				st.SendMS=float64(totalSend.Microseconds())/float64(framesInWindow)/1000
			}
			record(folder,st)
			framesInWindow=0;totalEncode=0;totalSend=0;timeWindow=now
		}
	}
}
