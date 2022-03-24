package main

import (
	"context"
	"flag"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"os/signal"
	"sync"
	"time"

	"github.com/chromedp/chromedp"
	"github.com/gorilla/websocket"
)

var ExecAllocatorOptions = []chromedp.ExecAllocatorOption{
	chromedp.NoFirstRun,
	chromedp.NoDefaultBrowserCheck,
	chromedp.Flag("autoplay-policy", "no-user-gesture-required"),
	chromedp.Flag("hide-scrollbars", true),
	chromedp.Flag("safebrowsing-disable-auto-update", true),
}

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool {
		return true
	},
}

var autoStart = flag.Bool("autoStart", false, "start chrome automatically")
var port = flag.Int("port", 8009, "http server listen port")
var appId = flag.String("appId", "", "app id")
var roomId = flag.String("roomId", "", "room id")
var userId = flag.String("userId", "", "user id")
var userToken = flag.String("userToken", "", "user token")

var wg sync.WaitGroup

func main() {
	flag.Parse()

	os.MkdirAll("./recording", 0777)

	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt)
	defer cancel()

	httpServer := &http.Server{Addr: fmt.Sprintf(":%d", *port), Handler: nil}

	go startServer(httpServer)

	if *autoStart {
		query := url.Values{}
		query.Add("autoStart", "1")
		query.Add("appId", *appId)
		query.Add("roomId", *roomId)
		query.Add("userId", *userId)
		query.Add("userToken", *userToken)

		if len(*userToken) == 0 {
			log.Fatal("please set userToken flag")
		}
		url := fmt.Sprintf("http://localhost:%d?%s", *port, query.Encode())

		time.AfterFunc(time.Millisecond*10, func() {
			startChrome(ctx, url)
		})
	}

	<-ctx.Done()

	httpServer.Shutdown(context.Background())
	wg.Wait()
	log.Println("stopped")
}

func startServer(server *http.Server) {
	http.HandleFunc("/ws", stream)
	http.Handle("/", http.FileServer(http.Dir("./web")))

	log.Println("http server at", server.Addr)
	log.Println(server.ListenAndServe())
}

func startChrome(ctx context.Context, url string) {
	options := append(chromedp.DefaultExecAllocatorOptions[:], chromedp.Flag("autoplay-policy", "no-user-gesture-required"))
	ctx, _ = chromedp.NewExecAllocator(ctx, options...)
	ctx, _ = chromedp.NewContext(ctx, chromedp.WithLogf(log.Printf))

	err := chromedp.Run(ctx, chromedp.Navigate(url))
	if err != nil {
		log.Fatal(err)
	}
	log.Println(url)
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

	wg.Add(1)

	defer func() {
		if writer != nil {
			writer.Close()
			log.Println("stop recording")

			go func() {
				defer wg.Done()
				log.Println("ffmpeg running")
				runFFmpegCmd(context.Background(), "-i", filename, "-c", "copy", basename+".mp4")
				log.Println("ffmpeg stopped")
			}()
		} else {
			wg.Done()
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

func runFFmpegCmd(ctx context.Context, args ...string) (cmd *exec.Cmd, err error) {
	cmd = exec.CommandContext(ctx, "ffmpeg", args...)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	if err := cmd.Run(); err != nil && err != ctx.Err() {
		log.Println("ffmpeg error", err)
	}
	return
}
