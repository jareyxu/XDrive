package backup

import (
	"fmt"
	"sync"
	"testing"
)

func TestPathPreservingVFSConcurrentRegistrationAndUnregistration(t *testing.T) {
	const workers = 8
	const iterations = 12
	start := make(chan struct{})
	errs := make(chan error, workers*iterations)
	var wg sync.WaitGroup
	for worker := 0; worker < workers; worker++ {
		wg.Add(1)
		go func(worker int) {
			defer wg.Done()
			<-start
			for iteration := 0; iteration < iterations; iteration++ {
				vfs, err := newPathPreservingVFS(fmt.Sprintf("/tmp/xdrive-snapshot-%d-%d", worker, iteration), nil)
				if err != nil {
					errs <- err
					return
				}
				if err := vfs.Close(); err != nil {
					errs <- err
					return
				}
			}
		}(worker)
	}
	close(start)
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Error(err)
	}
}
