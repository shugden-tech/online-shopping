// The most common passwords (lower-cased), refused at sign-up and on password change. Only ones of 8+ characters
// matter (shorter ones already fail the length rule). Sources: public "top 10k" lists, plus local patterns.
export const COMMON_PASSWORDS = new Set([
  "password", "password1", "password12", "password123", "password1234", "passw0rd", "p@ssw0rd", "p@ssword",
  "12345678", "123456789", "1234567890", "0123456789", "87654321", "987654321", "11111111", "00000000",
  "12341234", "11223344", "12121212", "123123123", "1q2w3e4r", "1q2w3e4r5t", "1qaz2wsx", "qwertyui",
  "qwerty123", "qwerty1234", "qwertyuiop", "asdfghjk", "asdfghjkl", "zxcvbnm1", "zxcvbnm123", "iloveyou",
  "iloveyou1", "sunshine", "princess", "football", "baseball", "superman", "starwars", "whatever",
  "trustno1", "letmein1", "welcome1", "welcome123", "admin123", "administrator", "abc12345", "abcd1234",
  "aa123456", "a1234567", "qwer1234", "q1w2e3r4", "1234qwer", "michael1", "charlie1", "computer",
  "internet", "jennifer", "jordan23", "mustang1", "shadow12", "master12", "monkey12", "dragon12",
  "football1", "liverpool", "chelsea1", "arsenal1", "samsung1", "samsung123", "iphone123", "google123",
  "facebook", "facebook1", "instagram", "changeme", "default1", "secret12", "loveyou1", "lovelove",
  "88888888", "99999999", "66666666", "55555555", "77777777", "22222222", "33333333", "44444444",
  "12344321", "147258369", "159753456", "741852963", "789456123", "456123789", "135792468", "1234554321",
  "mongolia", "mongolia1", "mongol123", "ulaanbaatar", "genzst123", "genzst2026", "perfume1", "parfum123",
  "qwerty12", "asdf1234", "zaq12wsx", "!qaz2wsx", "q1w2e3r4t5", "passpass", "testtest", "test1234",
]);
