# Makeblock's original firmware (not part of this project's MIT license)

Unmodified sketches from [Makeblock-Libraries/examples/Firmware_For_mBlock](https://github.com/Makeblock-official/Makeblock-Libraries/tree/master/examples/Firmware_For_mBlock),
kept here so `restore_factory.sh` can put the original firmware back:

* `mbot_firmware/` – 06.01.107, the mBlock "Live mode" firmware
* `mbot_factory_firmware/` – 06.01.009, the out-of-the-box program (IR remote, line/obstacle modes)

Copyright (C) 2013–2017 Maker Works Technology Co., Ltd. (Makeblock), licensed under
[CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/) as stated in each file's header.
They build against Makeblock's library (GPL-2.0, per its file headers), which `tools/setup.sh --factory`
downloads; it is not included here.

`backup/` (not in git) is where `tools/read_flash.py` puts a dump of your own robot's flash – see `restore_factory.sh`.
