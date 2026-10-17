package core

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"rnaxraydesktop/model"
)

// A card file travels with the project, so what it says (text, source,
// review) is only as trustworthy as whoever last wrote it. Cards this app
// saves or changes carry an HMAC under a key that never leaves this
// computer; a card without a valid one was made or edited elsewhere.

const (
	sealKeyFile = "evidence-seal.key"
	sealPrefix  = "hmac-sha256:"
	sealKeySize = 32
)

// sealKey reads this computer's key, creating it (0600) when create is set.
func (e *EvidenceService) sealKey(create bool) ([]byte, error) {
	if e.sealKeyPath == "" {
		return nil, nil
	}
	key, err := os.ReadFile(e.sealKeyPath)
	if errors.Is(err, os.ErrNotExist) && create {
		key = make([]byte, sealKeySize)
		if _, err := rand.Read(key); err != nil {
			return nil, err
		}
		if err := os.MkdirAll(filepath.Dir(e.sealKeyPath), 0o700); err != nil {
			return nil, err
		}
		f, err := os.OpenFile(e.sealKeyPath, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
		if errors.Is(err, os.ErrExist) {
			return e.sealKey(false) // made meanwhile
		}
		if err != nil {
			return nil, err
		}
		_, err = f.Write(key)
		if closeErr := f.Close(); err == nil {
			err = closeErr
		}
		return key, err
	}
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, nil
		}
		return nil, err
	}
	if len(key) != sealKeySize {
		return nil, fmt.Errorf("the evidence seal key %s is damaged", e.sealKeyPath)
	}
	return key, nil
}

// cardMAC is the seal of the card as it is stored (without its seal).
func cardMAC(key []byte, card model.EvidenceCard) string {
	card.LocalSeal, card.LocalOrigin, card.RawText = "", false, ""
	data, _ := json.Marshal(card)
	mac := hmac.New(sha256.New, key)
	mac.Write(data)
	return sealPrefix + hex.EncodeToString(mac.Sum(nil))
}

// seal marks card as made on this computer.
func (e *EvidenceService) seal(card *model.EvidenceCard) error {
	key, err := e.sealKey(true)
	if err != nil {
		return fmt.Errorf("could not seal the evidence card: %w", err)
	}
	card.LocalSeal, card.LocalOrigin = "", false
	if key != nil {
		card.LocalSeal, card.LocalOrigin = cardMAC(key, *card), true
	}
	return nil
}

// verify sets LocalOrigin when the card's seal is this computer's.
func (e *EvidenceService) verify(card *model.EvidenceCard) {
	card.LocalOrigin = false
	if card.LocalSeal == "" {
		return
	}
	key, err := e.sealKey(false)
	if err != nil || key == nil {
		return
	}
	card.LocalOrigin = hmac.Equal([]byte(cardMAC(key, *card)), []byte(card.LocalSeal))
}
