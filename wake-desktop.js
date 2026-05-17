const is_online = async (ip_address) => {
    const ping = require('ping');
    const response = await ping.promise.probe(ip_address, {
        timeout: 1,
        extra: ['-i', '1'],
    });
    return response.alive;
};


const main = async () => {
    const MAC_ADDRESS = process.env.MAC_ADDRESS;
    const IP_ADDRESS = process.env.IP_ADDRESS;
    const TIMEOUT = process.env.TIMEOUT;

    if (!MAC_ADDRESS || !IP_ADDRESS || !TIMEOUT) {
        console.error('MAC Address, IP Address, and Timeout must be provided');
        return;
    }

    console.log(`Checking if ${IP_ADDRESS} (${MAC_ADDRESS}) is already online`);

    if (await is_online(IP_ADDRESS)) {
        console.log(`${IP_ADDRESS} is already online`);
        return;
    }

    console.log(`Sending magic packet to ${MAC_ADDRESS}`);
    const wol = require('wakeonlan');
    await wol(MAC_ADDRESS);

    console.log(`Waiting for ${IP_ADDRESS} to be online (timeout ${TIMEOUT} seconds)`);
    const startTime = Date.now();
    while (!(await is_online(IP_ADDRESS))) {
        if ((Date.now() - startTime) / 1000 > TIMEOUT) {
            console.error(`Timeout reached. ${IP_ADDRESS} did not respond`);
            return;
        }
    }

    console.log(`${IP_ADDRESS} is now online (took ${(Date.now() - startTime) / 1000} seconds)`);
};
main();
