package main

import (
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"os"

	"github.com/objevovat/fairplay-sap-core-airplay2-sender-authentication-handshake/fpbridge"
)

func fail(err error) {
	fmt.Fprintln(os.Stderr, err)
	os.Exit(1)
}

func main() {
	if len(os.Args) < 2 {
		fail(fmt.Errorf("usage: fairplay-helper m1|m3 [base64-m2]"))
	}

	switch os.Args[1] {
	case "m1":
		m1 := fpbridge.NewFPSAPM1(
			fpbridge.FPSAPFullCapabilities,
		)

		fmt.Print(
			base64.StdEncoding.EncodeToString(m1),
		)

	case "m3":
		if len(os.Args) != 3 {
			fail(fmt.Errorf("m3 requires base64 m2"))
		}

		m2, err :=
			base64.StdEncoding.DecodeString(
				os.Args[2],
			)

		if err != nil {
			fail(err)
		}

		session, err :=
			fpbridge.NewFPSAPSession(
				rand.Reader,
			)

		if err != nil {
			fail(err)
		}

		m3, err :=
			session.ExchangeM3(m2)

		if err != nil {
			fail(err)
		}

		fmt.Print(
			base64.StdEncoding.EncodeToString(m3),
		)

	default:
		fail(
			fmt.Errorf(
				"unknown command: %s",
				os.Args[1],
			),
		)
	}
}