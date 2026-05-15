package main

import (
	"os"

	"github.com/monok8s/monok8s/apps/cli/cmd"
)

func main() {
	if err := cmd.NewRootCmd().Execute(); err != nil {
		os.Exit(1)
	}
}
