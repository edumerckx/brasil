var http = require('http'),
    request = require('request'),
    iconv = require('iconv-lite'),
    removerMascara = require('../formatacoesUtils').removerMascara,

    hostReceitaFederal = 'www.receita.fazenda.gov.br';

function executarParseDoHtml(body) {
    body = iconv.decode(body, 'iso-8859-1');

    if(body.indexOf('Esta página tem como objetivo') > -1) {
        throw new Error('A solução do captcha estava errada!');
    } else if(body.indexOf('O nmero do CNPJ no  vlido') > -1) {
        throw new Error('O número do CNPJ não é válido!');
    }

    function obterRegExp(atributo) {
        atributo = atributo.replace(/\(/g, '\\(').replace(/\)/g, '\\)');
        return new RegExp('<font face="Arial" style="font-size: 6pt">[\\s]*' + atributo + '[\\s]*</font>[\\s]*<br>[\\s]*<font face="Arial" style="font-size: 8pt">[\\s]*<b>(.*)</b>[\\s]*</font>[\\s]*', 'ig');
    }

    function extrair(atributo) {
        if(typeof atributo === 'string') {
            atributo = obterRegExp(atributo);
        }

        var matches = atributo.exec(body),
            match;

        if(matches) {
            match = matches.length > 1 ? matches[1] : matches[0];
            return match.trim();
        } else {
            return '';
        }
    }

    var regexes = {
        naoEncontrado: /No existe no Cadastro de Pessoas Jurdicas o nmero de CNPJ informado/g,
        cnpj: /[0-9]{2}\.[0-9]{3}\.[0-9]{3}\/[0-9]{4}\-[0-9]{2}/g,
        tipo: /MATRIZ|FILIAL/g,
        datas: /[0-9]{2}\/[0-9]{2}\/[0-9]{4}/g,
        hora: /[0-2]{1}[0-9]{1}:[0-5]{1}[0-9]{1}:[0-5]{1}[0-9]{1}/g,
        atividadeEconomicaSecundaria: /[\s]*<b>[\s]*([0-9]{2}\.[0-9]{2}-[0-9]{1}-[0-9]{2})\s-\s(.*)<\/b>/g,
        apenasAsteriscos: /^[\*]+$/g
    };

    if(regexes.naoEncontrado.test(body)) {
        throw new Error('O cnpj informado não existe');
    }

    var datas = body.match(regexes.datas),
        atividadeEconomicaPrincipal = extrair('C.DIGO E DESCRI..O DA ATIVIDADE ECON.MICA PRINCIPAL').split(' - '),
        atividadeEconomicaSecundaria,
        atividadesEconomicasSecundarias = [],
        naturezaJuridica = extrair('C.DIGO E DESCRI..O DA NATUREZA JUR.DICA').split(' - '),
        horaDaConsulta = body.match(regexes.hora);

    var i = 0;
    while(atividadeEconomicaSecundaria = regexes.atividadeEconomicaSecundaria.exec(body)) {
        if(i++ === 0) {
            continue;
        }

        atividadesEconomicasSecundarias.push({
            codigo: removerMascara(atividadeEconomicaSecundaria[1]),
            descricao: atividadeEconomicaSecundaria[2].trim()
        });
    }

    var resultados = {
        nome: {
            empresarial: extrair('NOME EMPRESARIAL'),
            fantasia: extrair('T.TULO DO ESTABELECIMENTO (NOME DE FANTASIA)')
        },
        cnpj: removerMascara(extrair(regexes.cnpj)),
        tipo: extrair(regexes.tipo),
        dataDeAbertura: datas && datas.length > 0 ? datas[0] : null,
        atividadesEconomicas: {
            principal: {
                codigo: removerMascara(atividadeEconomicaPrincipal[0]),
                descricao: atividadeEconomicaPrincipal[1]
            },
            secundarias: atividadesEconomicasSecundarias,
        },
        naturezaJuridica: {
            codigo: removerMascara(naturezaJuridica[0]),
            descricao: naturezaJuridica[1]
        },
        situacao: {
            cadastral: {
                descricao: extrair('SITUA..O CADASTRAL'),
                motivo: extrair('MOTIVO DE SITUA..O CADASTRAL') || null,
                data: datas && datas.length > 1 ? datas[1] : null,
            },
            especial: {
                descricao: extrair('SITUA..O ESPECIAL'),
                data: datas && datas.length > 4 ? datas[2] : null
            },
        },
        endereco: {
            logradouro: extrair('LOGRADOURO'),
            numero: extrair('N.MERO'),
            complemento: extrair('COMPLEMENTO'),
            cep: removerMascara(extrair('CEP')),
            bairro: extrair('BAIRRO/DISTRITO'),
            municipio: extrair('MUNIC.PIO'),
            uf: extrair('UF')
        },
        consulta: {
            data: datas ? (datas.length > 4 ? datas[3] : datas[2]) : null,
            hora: horaDaConsulta ? horaDaConsulta[0] : null,
            fuso: 'America/Sao_Paulo'
        }
    };

    if(regexes.apenasAsteriscos.test(resultados.nome.fantasia)) {
        resultados.nome.fantasia = null;
    }

    if(regexes.apenasAsteriscos.test(resultados.situacao.especial.descricao)) {
        resultados.situacao.especial.descricao = null;
    }

    return resultados;
}

function obterDados(cnpj, captcha, callback) {

    var jar = request.jar(),
        url = 'http://' + hostReceitaFederal + '/PessoaJuridica/CNPJ/cnpjreva/valida.asp';

    jar.setCookie(request.cookie(captcha.sessionId), url, function(){});

    request({
        method: 'POST',
        url: url,
        jar: jar,
        encoding: null,
        followAllRedirects: true,
        form: {
            origem: 'comprovante',
            viewstate: captcha.viewState,
            cnpj: removerMascara(cnpj),
            captcha: captcha.solucao,
            captchaAudio: '',
            submit1: 'Consultar',
            search_type: 'cnpj'
        }
    }, function(err, res, body) {
        if(err) {
            return callback(err);
        }

        try {
            callback(null, executarParseDoHtml(body));
        } catch(err) {
            callback(err);
        }
    });
}

function obterCaptcha(callback) {
    var captchaUrlRegExp = /<img border='.*' id='imgcaptcha' alt='.*' src='(.*)'>/,
        viewStateRegExp = /<input type=hidden id=viewstate name=viewstate value='(.*)'>/,
        sessionIdCookieRegExp = /^(ASPSESSIONID.*=.*;).*$/;

    function obterUrlDoCaptcha() {
        http.get({
            hostname: hostReceitaFederal,
            path: '/PessoaJuridica/CNPJ/cnpjreva/cnpjreva_solicitacao2.asp'
        }, function(res) {
            if(res.statusCode !== 200) {
                return callback(new Error('O request retornou o código ' + res.statusCode + ', que não era esperado'));
            }

            var sessionId = res.headers['set-cookie'],
                body;

            res.on('data', function(chunk) {
                body += chunk;
            });

            res.on('end', function() {
                var sessionIdMatches = res.headers['set-cookie'][0].match(sessionIdCookieRegExp),
                    viewStateMatches = body.match(viewStateRegExp),
                    captchaUrlMatches = body.match(captchaUrlRegExp);

                if(sessionIdMatches && viewStateMatches && captchaUrlMatches) {
                    obterBytesDoCaptcha(sessionIdMatches[1], viewStateMatches[1], captchaUrlMatches[1]);
                } else {
                    return callback(new Error('Impossível encontrar o valor do sessionId, do viewState ou do captchaUrl'));
                }
            });
        });
    }

    function obterBytesDoCaptcha(sessionId, viewState, captchaUrl) {
        http.get({
            host: hostReceitaFederal,
            path: captchaUrl.replace(/amp;/g, ''),
            headers: {
                cookie: sessionId
            }
        }, function(res) {
            if(res.statusCode !== 200) {
                return callback(new Error('O request retornou o código ' + res.statusCode + ', que não era esperado'));
            }

            var captchaEmBase64 = '';

            res.setEncoding('base64');

            res.on('data', function(chunk) {
                captchaEmBase64 += chunk;
            });

            res.on('end', function() {
                return callback(null, {
                    captchaEmBase64: captchaEmBase64,
                    contentType: res.headers['content-type'],
                    sessionId: sessionId,
                    viewState: viewState
                });
            });
        });
    }

    obterUrlDoCaptcha();
}

module.exports = {
    obterCaptcha: obterCaptcha,
    obterDados: obterDados
};