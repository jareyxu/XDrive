package main

import (
	"errors"
	"flag"
	"fmt"
	"os"
	"xdrive/internal/releasepackage"
)

func runReleasePackage(args []string) error {
	if len(args) == 0 {
		return errors.New("release-package requires prepare, check-installed, or remove-installed")
	}
	flags := flag.NewFlagSet("release-package", flag.ContinueOnError)
	archive := flags.String("archive", "", "release archive")
	root := flags.String("root", "", "application directory")
	architecture := flags.String("architecture", "", "target architecture")
	if err := flags.Parse(args[1:]); err != nil {
		return err
	}
	if len(flags.Args()) != 0 || *root == "" {
		return errors.New("release-package requires --root")
	}
	var err error
	switch args[0] {
	case "prepare":
		err = releasepackage.Prepare(*archive, *root, *architecture)
	case "check-installed":
		err = releasepackage.CheckInstalled(*root)
	case "remove-installed":
		err = releasepackage.RemoveInstalled(*root)
	case "sync-tree":
		err = releasepackage.SyncTree(*root)
	case "sync-directory":
		err = releasepackage.SyncDirectory(*root)
	default:
		err = errors.New("unsupported release-package command")
	}
	if err != nil {
		fmt.Fprintf(os.Stderr, "Release package validation failed: %v\n", err)
	}
	return err
}
