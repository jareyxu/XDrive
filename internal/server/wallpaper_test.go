package server

import (
	"context"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"xdrive/internal/db"
)

func TestSystemWallpaperSelectionPersistsAndRejectsUnknownIDs(t *testing.T) {
	database, err := db.Open(context.Background(), filepath.Join(t.TempDir(), "xdrive.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()

	get := httptest.NewRecorder()
	getSystemWallpaperSelection(get, httptest.NewRequest("GET", "/api/v1/system/wallpaper/selection", nil), database)
	if get.Code != 200 || !strings.Contains(get.Body.String(), `"builtinId":"default"`) {
		t.Fatalf("initial wallpaper selection = %d %s", get.Code, get.Body.String())
	}

	put := httptest.NewRecorder()
	putSystemWallpaperSelection(put, httptest.NewRequest("PUT", "/api/v1/system/wallpaper/selection", strings.NewReader(`{"builtinId":"03"}`)), database)
	if put.Code != 204 {
		t.Fatalf("save wallpaper selection = %d %s", put.Code, put.Body.String())
	}

	get = httptest.NewRecorder()
	getSystemWallpaperSelection(get, httptest.NewRequest("GET", "/api/v1/system/wallpaper/selection", nil), database)
	if get.Code != 200 || !strings.Contains(get.Body.String(), `"builtinId":"03"`) {
		t.Fatalf("saved wallpaper selection = %d %s", get.Code, get.Body.String())
	}

	for _, body := range []string{`{"builtinId":"unknown"}`, `{"builtinId":"03","other":true}`, `{"builtinId":"03"}{}`} {
		put = httptest.NewRecorder()
		putSystemWallpaperSelection(put, httptest.NewRequest("PUT", "/api/v1/system/wallpaper/selection", strings.NewReader(body)), database)
		if put.Code != 400 {
			t.Errorf("accepted invalid selection %s: %d %s", body, put.Code, put.Body.String())
		}
	}

	putWallpaper := httptest.NewRecorder()
	request := httptest.NewRequest("PUT", "/api/v1/system/wallpaper", strings.NewReader("\xff\xd8\xff"))
	request.Header.Set("Content-Type", "image/jpeg")
	putSystemWallpaper(putWallpaper, request, database)
	if putWallpaper.Code != 204 {
		t.Fatalf("save custom wallpaper = %d %s", putWallpaper.Code, putWallpaper.Body.String())
	}
	get = httptest.NewRecorder()
	getSystemWallpaperSelection(get, httptest.NewRequest("GET", "/api/v1/system/wallpaper/selection", nil), database)
	if !strings.Contains(get.Body.String(), `"builtinId":"custom"`) {
		t.Fatalf("custom wallpaper did not become active: %s", get.Body.String())
	}

	delete := httptest.NewRecorder()
	deleteSystemWallpaper(delete, httptest.NewRequest("DELETE", "/api/v1/system/wallpaper", nil), database)
	if delete.Code != 204 {
		t.Fatalf("delete custom wallpaper = %d %s", delete.Code, delete.Body.String())
	}
	get = httptest.NewRecorder()
	getSystemWallpaperSelection(get, httptest.NewRequest("GET", "/api/v1/system/wallpaper/selection", nil), database)
	if !strings.Contains(get.Body.String(), `"builtinId":"default"`) {
		t.Fatalf("deleting custom wallpaper did not restore default: %s", get.Body.String())
	}
	var updatedAt int64
	if err := database.QueryRow("SELECT updated_at FROM system_wallpaper_state WHERE id = 1").Scan(&updatedAt); err != nil || updatedAt <= time.Now().Add(-time.Minute).Unix() {
		t.Fatalf("wallpaper selection timestamp was not updated: %d %v", updatedAt, err)
	}
}
