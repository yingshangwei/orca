#include <CoreFoundation/CoreFoundation.h>
#include <Security/Security.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>

#ifndef ORCA_RELAY_KEYCHAIN_SERVICE
#define ORCA_RELAY_KEYCHAIN_SERVICE "com.stablyai.orca.mobile-relay"
#endif

static const char service[] = ORCA_RELAY_KEYCHAIN_SERVICE;
static const char account[] = "sealing-key-v1";
enum { KEY_BYTES = 32 };

static void clear_bytes(void *buffer, size_t length) {
  volatile unsigned char *cursor = buffer;
  while (length-- > 0) *cursor++ = 0;
}

static OSStatus read_key(SecKeychainRef keychain, void **data, UInt32 *length) {
  return SecKeychainFindGenericPassword(keychain, sizeof(service) - 1, service,
      sizeof(account) - 1, account, length, data, NULL);
}

int main(int argc, char **argv) {
  if (argc != 2 || (strcmp(argv[1], "status") != 0 &&
      strcmp(argv[1], "read") != 0 && strcmp(argv[1], "get-or-create") != 0)) return 2;

  OSStatus status = SecKeychainSetUserInteractionAllowed(false);
  Boolean allowed = true;
  if (status == errSecSuccess) status = SecKeychainGetUserInteractionAllowed(&allowed);
  if (status != errSecSuccess || allowed) return 3;

  SecKeychainRef keychain = NULL;
  status = SecKeychainCopyDefault(&keychain);
  SecKeychainStatus flags = 0;
  if (status == errSecSuccess) status = SecKeychainGetStatus(keychain, &flags);
  if (status == errSecSuccess && (flags & kSecUnlockStateStatus) == 0)
    status = errSecInteractionNotAllowed;

  void *data = NULL;
  UInt32 length = 0;
  if (status == errSecSuccess && strcmp(argv[1], "status") != 0) {
    if (isatty(STDOUT_FILENO)) {
      status = errSecParam;
    } else {
      status = read_key(keychain, &data, &length);
      if (status == errSecItemNotFound && strcmp(argv[1], "get-or-create") == 0) {
        unsigned char generated[KEY_BYTES];
        status = SecRandomCopyBytes(kSecRandomDefault, sizeof(generated), generated);
        if (status == errSecSuccess)
          status = SecKeychainAddGenericPassword(keychain, sizeof(service) - 1, service,
              sizeof(account) - 1, account, sizeof(generated), generated, NULL);
        clear_bytes(generated, sizeof(generated));
        if (status == errSecSuccess || status == errSecDuplicateItem)
          status = read_key(keychain, &data, &length);
      }
      if (status == errSecSuccess && length != KEY_BYTES) status = errSecDecode;
      if (status == errSecSuccess && fwrite(data, 1, length, stdout) != length)
        status = errSecIO;
      if (status == errSecSuccess && fflush(stdout) != 0) status = errSecIO;
    }
  }
  if (data != NULL) {
    clear_bytes(data, length);
    SecKeychainItemFreeContent(NULL, data);
  }
  if (keychain != NULL) CFRelease(keychain);
  if (status != errSecSuccess) fprintf(stderr, "relay_keychain_status=%d\n", (int)status);
  return status == errSecSuccess ? 0 : 1;
}
