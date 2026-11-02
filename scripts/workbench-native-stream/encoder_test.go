package main

import (
    "bytes"
    "image"
    "image/jpeg"
    "testing"

    "github.com/gen2brain/jpegn"
)

// Generate a synthetic, changing-desktop-like frame without inspecting the host.
func syntheticFrame(width, height int) *image.NRGBA {
    frame := image.NewNRGBA(image.Rect(0, 0, width, height))
    for y := 0; y < height; y++ {
        for x := 0; x < width; x++ {
            i := y*frame.Stride + x*4
            frame.Pix[i] = uint8(x)
            frame.Pix[i+1] = uint8(y)
            frame.Pix[i+2] = uint8(x ^ y)
            frame.Pix[i+3] = 255
        }
    }
    return frame
}

func TestSIMDJPEGStandardDecoderCompatibility(t *testing.T) {
    frame := syntheticFrame(320, 240)
    var encoded bytes.Buffer
    if err := jpegn.Encode(&encoded, frame, &jpegn.EncodeOptions{Quality: 65}); err != nil {
        t.Fatal(err)
    }
    decoded, err := jpeg.Decode(bytes.NewReader(encoded.Bytes()))
    if err != nil {
        t.Fatalf("Windows/Chromium-compatible JPEG decoding failed: %v", err)
    }
    if decoded.Bounds() != frame.Bounds() {
        t.Fatalf("image dimensions changed: got %v, want %v", decoded.Bounds(), frame.Bounds())
    }
    if n := encoded.Len(); n < 200 || n > maxFrameBytes {
        t.Fatalf("encoded frame violates the stream's frame-size limits: %d", n)
    }
}

func BenchmarkStdlibJPEG1024(b *testing.B) {
    frame := syntheticFrame(1024, 768)
    b.ReportAllocs()
    b.ResetTimer()
    for i := 0; i < b.N; i++ {
        var out bytes.Buffer
        if err := jpeg.Encode(&out, frame, &jpeg.Options{Quality: 65}); err != nil {
            b.Fatal(err)
        }
    }
}

func BenchmarkSIMDJPEG1024(b *testing.B) {
    frame := syntheticFrame(1024, 768)
    b.ReportAllocs()
    b.ResetTimer()
    for i := 0; i < b.N; i++ {
        var out bytes.Buffer
        if err := jpegn.Encode(&out, frame, &jpegn.EncodeOptions{Quality: 65}); err != nil {
            b.Fatal(err)
        }
    }
}

func BenchmarkSIMDJPEG1920(b *testing.B) {
    frame := syntheticFrame(1920, 1080)
    b.ReportAllocs()
    b.ResetTimer()
    for i := 0; i < b.N; i++ {
        var out bytes.Buffer
        if err := jpegn.Encode(&out, frame, &jpegn.EncodeOptions{Quality: 65}); err != nil {
            b.Fatal(err)
        }
    }
}
