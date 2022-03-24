package main

import (
	"context"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool {
		return true
	},
}

func main() {
	os.MkdirAll("./recording", 0777)
	http.HandleFunc("/ws", stream)
	http.Handle("/", http.FileServer(http.Dir("./web")))
	http.ListenAndServe(":8009", nil)
}

func stream(w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}

	once := sync.Once{}
	basename := fmt.Sprintf("./recording/%s", time.Now().Format("2006_01_02_15_04_05"))
	filename := fmt.Sprintf("%s.flv", basename)

	var writer io.WriteCloser

	defer func() {
		if writer != nil {
			writer.Close()
			log.Println("stop recording")
			asyncRunFFmpegCmd(context.Background(), "-i", filename, "-c", "copy", basename+".mp4")
		}
	}()

	init := func() {
		log.Println("start recording", filename)
		writer, err = os.Create(filename)
	}

	for {
		mt, data, errConn := conn.ReadMessage()
		if errConn != nil {
			return
		}
		if mt == websocket.BinaryMessage {
			once.Do(init)
			if err != nil {
				log.Println("failed to start recording", err)
				break
			}
			if _, err = writer.Write(data); err != nil {
				break
			}
		}
	}
}

func asyncRunFFmpegCmd(ctx context.Context, args ...string) (cmd *exec.Cmd, err error) {
	cmd = exec.CommandContext(ctx, "ffmpeg", args...)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	go func() {
		if err := cmd.Run(); err != nil && err != ctx.Err() {
			log.Println("ffmpeg error", err)
		}
	}()
	return
}
