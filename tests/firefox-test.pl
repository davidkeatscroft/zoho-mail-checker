#!/usr/bin/perl
# Loads the extension into a throwaway headless Firefox profile, runs tests/run.html,
# then screenshots the real pages. Usage: firefox-test.pl <screenshot-dir>
use strict;
use warnings;
use File::Temp qw(tempdir);
use File::Basename qw(dirname);
use Cwd qw(abs_path);
use IO::Socket::INET;
use JSON::PP;
use MIME::Base64;
binmode(STDOUT, ":utf8");

my $out = shift // die "usage: $0 <screenshot-dir>\n";
my $root = abs_path(dirname(abs_path($0)) . '/..');
my $firefox = '/Applications/Firefox.app/Contents/MacOS/firefox';
my $port = 2839;
my $uuid = '11111111-1111-4111-8111-111111111111';
my $base = "moz-extension://$uuid";
my $profile = tempdir('zmc-profile-XXXXXX', TMPDIR => 1, CLEANUP => 1);

open my $prefs, '>', "$profile/user.js" or die $!;
print $prefs qq{user_pref("marionette.port", $port);\n};
print $prefs qq{user_pref("extensions.webextensions.uuids", "{\\"zoho-mail-checker\@davidkeatscroft.com\\":\\"$uuid\\"}");\n};
print $prefs qq{user_pref("extensions.background.idle.timeout", 600000);\n};
print $prefs qq{user_pref("browser.shell.checkDefaultBrowser", false);\n};
print $prefs qq{user_pref("datareporting.policy.dataSubmissionEnabled", false);\n};
print $prefs qq{user_pref("toolkit.telemetry.enabled", false);\n};
close $prefs;

$ENV{MOZ_HEADLESS} = 1;
$ENV{MOZ_REMOTE_ALLOW_SYSTEM_ACCESS} = 1;
$ENV{MOZ_HEADLESS_WIDTH} = 1100;
$ENV{MOZ_HEADLESS_HEIGHT} = 900;
my $pid = fork() // die;
if (!$pid) {
  open STDOUT, '>', '/dev/null';
  open STDERR, '>', '/dev/null';
  exec $firefox, '--marionette', '--no-remote', '--profile', $profile;
}
END { if ($pid) { kill 'TERM', $pid; waitpid($pid, 0); } }

my $sock;
for (1 .. 60) {
  $sock = IO::Socket::INET->new(PeerAddr => '127.0.0.1', PeerPort => $port, Proto => 'tcp');
  last if $sock;
  select(undef, undef, undef, 0.5);
}
die "could not reach Firefox\n" unless $sock;

my $json = JSON::PP->new->utf8->allow_nonref;
sub read_packet {
  my $len = '';
  while (1) {
    read($sock, my $c, 1) or die "connection closed\n";
    last if $c eq ':';
    $len .= $c;
  }
  my $data = '';
  while (length($data) < $len) {
    read($sock, my $chunk, $len - length($data)) or die "connection closed\n";
    $data .= $chunk;
  }
  return $json->decode($data);
}
read_packet();

my $id = 0;
sub cmd {
  my ($name, $params) = @_;
  my $payload = $json->encode([0, ++$id, $name, $params // {}]);
  print $sock length($payload) . ':' . $payload;
  $sock->flush;
  my $reply = read_packet();
  die "$name failed: " . ($reply->[2]{message} // 'unknown') . "\n" if $reply->[2];
  return $reply->[3];
}
sub js { return cmd('WebDriver:ExecuteScript', { script => $_[0], args => [] })->{value}; }
sub shot {
  my $name = shift;
  my $png = cmd('WebDriver:TakeScreenshot', { full => JSON::PP::false })->{value};
  open my $f, '>:raw', "$out/$name.png" or die $!;
  print $f decode_base64($png);
  close $f;
  print "SHOT $out/$name.png\n";
}
sub wait_for {
  my ($script, $what) = @_;
  for (1 .. 100) {
    return if js($script);
    select(undef, undef, undef, 0.1);
  }
  die "timed out waiting for $what\n";
}

cmd('WebDriver:NewSession', { capabilities => { alwaysMatch => { 'moz:webdriverClick' => JSON::PP::true } } });
my $addon = cmd('Addon:Install', { path => $root, temporary => JSON::PP::true });
print "INSTALLED $addon->{value}\n";
sleep 1;

# Extension pages can't be navigated to directly, so start from the settings tab
# the extension opens on install, then move that tab to the tests.
my $start;
for (1 .. 50) {
  for my $handle (@{ cmd('WebDriver:GetWindowHandles') }) {
    cmd('WebDriver:SwitchToWindow', { handle => $handle, focus => JSON::PP::true });
    if (cmd('WebDriver:GetCurrentURL')->{value} =~ /^moz-extension:/) { $start = $handle; last; }
  }
  last if $start;
  select(undef, undef, undef, 0.2);
}
die "the extension did not open its settings page on install\n" unless $start;
# Test page first, in its own tab, so the mock server stays alive for the screenshots.
js(qq{window.location.href = "$base/tests/run.html";});
wait_for('return document.getElementById("output") !== null;', 'test page');
my $finished = 0;
for (1 .. 300) {
  if (js('return document.title === "finished";')) { $finished = 1; last; }
  select(undef, undef, undef, 0.1);
}
print js('return document.getElementById("output").textContent;'), "\n";
die "tests did not finish\n" unless $finished;
wait_for('return document.title === "finished";', 'demo data');

sub open_tab {
  my $url = shift;
  my %before = map { $_ => 1 } @{ cmd('WebDriver:GetWindowHandles') };
  js(qq{(window.wrappedJSObject || window).browser.tabs.create({ url: "$url" });});
  for (1 .. 50) {
    my ($new) = grep { !$before{$_} } @{ cmd('WebDriver:GetWindowHandles') };
    if ($new) {
      cmd('WebDriver:SwitchToWindow', { handle => $new, focus => JSON::PP::true });
      return $new;
    }
    select(undef, undef, undef, 0.1);
  }
  die "tab did not open: $url\n";
}

open_tab("$base/popup/popup.html");
cmd('WebDriver:SetWindowRect', { width => 460, height => 700 });
wait_for('return document.querySelectorAll(".row").length === 3;', 'popup rows');
print "POPUP title: ", js('return document.getElementById("title").textContent;'), "\n";
print "POPUP first row: ", js('return document.querySelector(".row .sender").textContent + " | " + document.querySelector(".row .subject").textContent;'), "\n";
shot('popup-list');

js('document.querySelector(".row").click();');
wait_for('const f = document.getElementById("body-frame"); return !f.hidden && f.contentDocument && f.contentDocument.body && f.contentDocument.body.textContent.includes("budget");', 'message body');
select(undef, undef, undef, 0.3);
print "READ script ran: ", js('return document.getElementById("body-frame").contentDocument.body.textContent.includes("SCRIPT RAN");') ? "YES (BAD)" : "no", "\n";
print "READ remote banner shown: ", js('return !document.getElementById("remote-banner").hidden;') ? "yes" : "NO", "\n";
print "READ image loaded: ", js('return document.getElementById("body-frame").contentDocument.images[0].naturalWidth > 0;') ? "YES (BAD)" : "no", "\n";
shot('popup-read');

js('document.getElementById("reply").click();');
wait_for('return document.getElementById("reply-to").value === "support@example.com";', 'Reply-To prefill');
print "REPLY to prefilled: ", js('return document.getElementById("reply-to").value;'), "\n";
shot('popup-reply');

js('document.getElementById("reply-cancel").click(); document.querySelector("[data-action=archive]").click();');
wait_for('return !document.getElementById("list-view").hidden && document.querySelectorAll(".row").length === 2;', 'archive to return to list');
print "ARCHIVE from reading view: returned to list with 2 rows\n";

cmd('WebDriver:SetWindowRect', { width => 900, height => 1200 });
open_tab("$base/options/options.html");
wait_for('return document.querySelectorAll(".folders input").length > 0;', 'options accounts');
print "OPTIONS folders offered: ", js('return [...document.querySelectorAll(".folders .check")].map(l => l.textContent.trim()).join(", ");'), "\n";
print "OPTIONS redirect URI: ", js('return document.getElementById("redirect-uri").textContent;'), "\n";
shot('options');
print "OK\n";
